import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTciExpressNumber, parseTciExpress, PROVIDER, TCI_EXPRESS_MAX_BYTES } from './parser.js';

/** The page the tracking form on www.tciexpress.in opens for a docket. */
export const TCI_EXPRESS_TRACKER = 'https://www.tciexpress.in/track-your-shipment';
const REDIRECTS = [301, 302, 303, 307, 308];

export class TciExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTciExpressNumber(raw);
    const url = `${TCI_EXPRESS_TRACKER}?${new URLSearchParams({ trackshipment: number, dwb: 'dwb' })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TCI_EXPRESS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TCI Express redirected its tracking page');
      // The page answers an unknown docket with HTTP 200; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'TCI Express tracking page is unavailable');
      return parseTciExpress(decodeText(bytes), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tci-express', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: TCI_EXPRESS_MAX_BYTES,
        parse: html => parseTciExpress(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TciExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: 'tci-express', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
