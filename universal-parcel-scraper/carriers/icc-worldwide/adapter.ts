import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ICC_WORLDWIDE_MAX_BYTES, normalizeIccWorldwideNumber, parseIccWorldwide, PROVIDER } from './parser.js';

// The address the tracking form on www.iccworld.com sends an air waybill to, which renders the shipment on the server.
export const ICC_WORLDWIDE_ENDPOINT = 'https://www.iccworld.com/track-result.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the page answers unknown numbers with a notice.
const GONE = [404, 410];

/** The tracking page's address for one whole air waybill, as the tracking form builds it. */
export function iccWorldwideLookupUrl(raw: string): string {
  return `${ICC_WORLDWIDE_ENDPOINT}?${new URLSearchParams({ track_no: normalizeIccWorldwideNumber(raw) })}`;
}

export class IccWorldwideTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIccWorldwideNumber(raw);
    const url = iccWorldwideLookupUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ICC_WORLDWIDE_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ICC Worldwide redirected its tracking page');
      if (GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'ICC Worldwide tracking page is unavailable', { status: response.status });
      }
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'ICC Worldwide returned an empty page');
      return parseIccWorldwide(html, number);
    };
    // A request that fails to reach ICC, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'icc-worldwide', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IccWorldwideTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'icc-worldwide', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeIccWorldwideNumber(number))),
  };
};
