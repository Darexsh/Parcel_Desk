import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { L_POST_MAX_BYTES, lPostResult, normalizeLPostNumber, parseLPostOrder, PROVIDER, type LPostOrder } from './parser.js';

/** The backend the tracking page on l-post.ru asks: the order for a number, then its status history. */
export const L_POST_API = 'https://l-post.ru/l-backend';
export const L_POST_ORDER_URL = `${L_POST_API}/tracking`;
export const L_POST_HISTORY_URL = `${L_POST_API}/tracking/get-order-history`;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Russian hosts and CDNs put in place of a reply.
const CHALLENGE = /ddos-guard|__qrator|qrator\.net|smartcaptcha|captcha-api\.yandex|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;

export class LPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One JSON POST as the page sends it. A redirect or a missing route is a moved backend, not an answer. */
  async #post(url: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify(body) }, { provider: PROVIDER, timeoutMs, maxBytes: L_POST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 405, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'L-POST redirected its tracking lookup');
    if (response.status !== 200) throw new TransportError(PROVIDER, 'L-POST tracking lookup is unavailable', { status: response.status });
    const text = decodeText(bytes);
    try {
      return JSON.parse(text);
    } catch (cause) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'L-POST answered with a browser check', { cause });
      throw new SchemaError(PROVIDER, 'L-POST returned a reply that is not JSON', { cause });
    }
  }

  #order(number: string, signal: AbortSignal, timeoutMs: number): Promise<LPostOrder> {
    return this.#post(L_POST_ORDER_URL, { OrderTracking: { trackNumber: number, phoneNumber: '' } }, signal, timeoutMs)
      .then((payload) => parseLPostOrder(payload, number));
  }

  #steps<T>(context: TrackingContext, read: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
    // A request that fails to reach L-POST, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'l-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLPostNumber(raw);
    return this.#steps(context, async (signal, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      const order = await this.#order(number, signal, timeoutMs);
      // The page asks for the history by the order's number, which is the number asked.
      const history = await this.#post(L_POST_HISTORY_URL, { orderData: order.number }, signal, Math.max(1, deadline - Date.now()));
      return lPostResult(order, history);
    });
  }

  /** Whether L-POST holds an order under the number: the order lookup alone, without its history. */
  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeLPostNumber(number))) return { known: false };
    try {
      await this.#steps(context, (signal, timeoutMs) => this.#order(normalizeLPostNumber(number), signal, timeoutMs));
    } catch (error) {
      if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
      throw error;
    }
    // Wall clocks without a zone cannot date the order's last activity.
    return { known: true, lastActivityAt: null };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'l-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
