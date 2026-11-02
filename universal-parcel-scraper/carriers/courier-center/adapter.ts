import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COURIER_CENTER_MAX_BYTES, isCourierCenterBlockPage, normalizeCourierCenterNumber, parseCourierCenter, PROVIDER } from './parser.js';

/** The result page Courier Center's tracking form opens. */
export const COURIER_CENTER_TRACKER = 'https://www.courier.gr/track/result/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing waybill from a 200 reply; a 404 is a moved route.
const UNAVAILABLE = [404, 410];

export function courierCenterTrackerUrl(number: string): string {
  return `${COURIER_CENTER_TRACKER}?${new URLSearchParams({ tracknr: number })}`;
}

export class CourierCenterTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCourierCenterNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // Cloudflare answers a burst of lookups with HTTP 429 and a Retry-After,
      // which the transport reports as a rate limit.
      const { response, bytes } = await fetchBounded(courierCenterTrackerUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COURIER_CENTER_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Courier Center redirected its tracking page');
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Courier Center tracking page is unavailable');
      const html = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isCourierCenterBlockPage(html) ? 'Courier Center answered with a block page' : 'Courier Center refused the lookup', { status: 403 });
      }
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Courier Center did not answer with its tracking page');
      return parseCourierCenter(html, number);
    };
    // A read that fails to reach Courier Center, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'courier-center', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CourierCenterTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'courier-center', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCourierCenterNumber(number))),
  };
};
