import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, EUSHIPMENTS_MAX_BYTES, normalizeEushipmentsNumber, parseEushipments, parseEushipmentsError, PROVIDER } from './parser.js';

/** The tracking page's form handler, which looks up the number it is posted. */
export const EUSHIPMENTS_TRACKER = 'https://eushipments.com/wp-admin/admin-ajax.php?action=track_order_form';
const REDIRECTS = [301, 302, 303, 307, 308];
// The handler answers an unknown number with an error: a missing route is not a missing shipment.
const GONE = [400, 404, 405, 410];

export class EushipmentsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEushipmentsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(EUSHIPMENTS_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ tracking_number: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: EUSHIPMENTS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const status = response.status;
      if (status === 403) throw new ChallengeError(PROVIDER, 'euShipments refused the lookup', { status });
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'euShipments tracking handler is unavailable', { status });
      const body = decodeText(bytes);
      // An order comes back as a piece of HTML; no order, as a JSON error.
      if (/^\s*\{/.test(body)) {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
        return parseEushipmentsError(payload);
      }
      return parseEushipments(body, number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EushipmentsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEushipmentsNumber(number))),
  };
};
