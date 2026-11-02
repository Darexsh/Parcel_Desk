import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EURODIS_MAX_BYTES, eurodisLookup, parseEurodis, PROVIDER, type EurodisLookup } from './parser.js';

export const EURODIS_PAGE = 'https://eurodis.com/track-trace';
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The request the tracking page makes for one number. A barcode goes in the
 * page's own address, `/track-trace?{barcode}`, which a result page gives
 * itself; a shipment number is posted as the page's shipment-number form
 * posts it.
 */
export function eurodisRequest({ number, kind }: EurodisLookup): { url: string; init: RequestInit } {
  if (kind === 'collo') return { url: `${EURODIS_PAGE}?${number}`, init: { method: 'GET' } };
  return { url: EURODIS_PAGE, init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ track_and_trace_hidden_field: 'trackEurodis', 'trackEurodis-input': number }).toString() } };
}

export class EurodisTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const lookup = eurodisLookup(raw);
    const { url, init } = eurodisRequest(lookup);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // No cookie: without the site's language cookie the page answers in English.
      const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
        ...(init.headers as Record<string, string> | undefined), 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EURODIS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      // The page reports a missing shipment with HTTP 200; a redirect or a 404 is a moved page.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'EURODIS tracking page moved');
      return parseEurodis(decodeText(bytes), lookup.number);
    };
    // A request that fails to reach EURODIS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'eurodis', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EurodisTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'eurodis', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
