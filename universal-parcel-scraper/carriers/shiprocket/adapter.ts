import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import {
  isShiprocketNotFound, normalizeShiprocketNumber, parseShiprocket, parseShiprocketEstimate, PROVIDER,
  SHIPROCKET_CHALLENGE, SHIPROCKET_MAX_BYTES, SHIPROCKET_ORIGIN,
} from './parser.js';

/** The API the tracking page asks for its delivery estimate. */
export const SHIPROCKET_API = 'https://apiv2.shiprocket.co';
const REDIRECTS = [301, 302, 303, 307, 308];
// The estimate is a nicety: it never takes more than this out of the lookup.
const ESTIMATE_MS = 5_000;

export function shiprocketTrackingUrl(raw: string): string {
  return `${SHIPROCKET_ORIGIN}/tracking/${normalizeShiprocketNumber(raw)}`;
}

export class ShiprocketTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** `estimate: false` leaves out the delivery estimate, as recognition needs only the page. */
  async fetch(raw: string, context: TrackingContext = {}, { estimate = true }: { estimate?: boolean } = {}): Promise<CarrierResult> {
    const number = normalizeShiprocketNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const { response, bytes } = await fetchBounded(shiprocketTrackingUrl(number), { signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHIPROCKET_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 410], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Shiprocket redirected its tracking page', { status: response.status });
      // The route answers every AWB; without it, the tracker moved.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Shiprocket tracking page is unavailable', { status: response.status });
      const html = decodeText(bytes);
      if (response.status === 400) {
        if (isShiprocketNotFound(html)) throw new NotFoundError(PROVIDER);
        if (SHIPROCKET_CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shiprocket answered with a block page');
        throw new IndeterminateError(PROVIDER, 'Shiprocket refused the tracking page', { status: 400 });
      }
      const { result, orderId } = parseShiprocket(html, number);
      const left = deadline - Date.now();
      if (!estimate || !orderId || result.current_stage === 'delivered' || left < 500) return result;
      // The page asks for its estimate once it has loaded; a lookup without it still stands.
      try {
        const estimate = await fetchBounded(`${SHIPROCKET_API}/pocx/tracking-order-edd/${orderId}`, { signal, headers: {
          Accept: 'application/json', Origin: SHIPROCKET_ORIGIN, Referer: `${SHIPROCKET_ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.min(ESTIMATE_MS, Math.floor(left)), maxBytes: 16 * 1024, fetcher: this.options.fetcher });
        const day = parseShiprocketEstimate(parseJsonBytes(estimate.bytes, PROVIDER));
        return day ? { ...result, expected_delivery: day } : result;
      } catch (error) {
        if (signal.aborted) throw error;
        return result;
      }
    };
    // A request that fails to reach Shiprocket, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'shiprocket', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShiprocketTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shiprocket', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, { estimate: false }),
      () => accepted(() => normalizeShiprocketNumber(number))),
  };
};
