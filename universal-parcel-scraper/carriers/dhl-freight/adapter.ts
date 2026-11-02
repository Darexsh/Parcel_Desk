import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DHL_FREIGHT_MAX_BYTES, dhlFreightQuery, parseDhlFreight, PROVIDER, type DhlFreightQuery } from './parser.js';

/** ActiveTracing's search, which opens a consignment's details when the number matches one. */
export const DHL_FREIGHT_SEARCH = 'https://activetracing.dhl.com/DatPublic/datSelection.do';
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The English search for one number, as the page's own links and forms send it:
 * an order code or consignment ID in `a`, a package ID in the package field.
 */
export function dhlFreightSearchUrl(query: DhlFreightQuery): string {
  const params: Record<string, string> = query.field === 'package'
    ? { search: 'consignmentId', at: 'package', valuePackageField: query.value, focus: 'search3', searchConsignmentId: 'track', l: 'EN' }
    : { autoSearch: 'true', search: 'consignmentId', l: 'EN', a: query.value };
  return `${DHL_FREIGHT_SEARCH}?${new URLSearchParams(params)}`;
}

export class DhlFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = dhlFreightQuery(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(dhlFreightSearchUrl(query), { signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DHL_FREIGHT_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'DHL Freight redirected its search', { status: response.status });
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'DHL Freight search is unavailable', { status: response.status });
      return parseDhlFreight(decodeText(bytes), query);
    };
    // A read that fails to reach ActiveTracing, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dhl-freight', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: dhlFreightSearchUrl(query), maxBytes: DHL_FREIGHT_MAX_BYTES,
        parse: html => parseDhlFreight(html, query) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new DhlFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dhl-freight', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => dhlFreightQuery(number))),
  };
};
