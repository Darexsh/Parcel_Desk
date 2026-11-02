import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FIVE_POST_MAX_BYTES, fivePostOrderId, normalizeFivePostNumber, parseFivePost, PROVIDER } from './parser.js';

/** The guest tracking API of 5Post's app (ru.x5.omni). */
export const FIVE_POST_API = 'https://api-omni.x5.ru/five-post-mobile-api/v3/mobile';
const REDIRECTS = [301, 302, 303, 307, 308];
// ServicePipe's bot check, which fronts X5's hosts.
const CHALLENGE = /servicepipe\.tech|js-challenge-loader|id_captcha_frame_div|get_cookie_spsn|<title>\s*(?:403 )?Forbidden/i;

/** The orders the app lists under a number, one order's details, and that order's status history. */
export const fivePostUrls = (number: string, orderId = '') => ({
  orders: `${FIVE_POST_API}/order-tracking/${encodeURIComponent(number)}/orders`,
  details: `${FIVE_POST_API}/order-tracking/${encodeURIComponent(number)}/orders/${encodeURIComponent(orderId)}`,
  history: `${FIVE_POST_API}/orders/${encodeURIComponent(orderId)}/status-history`,
});

export class FivePostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One GET; a 404 is returned for the caller to read, as it means different things on each route. */
  async #get(url: string, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: FIVE_POST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, '5Post redirected its tracking API');
    const text = decodeText(bytes);
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch (cause) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '5Post answered with its bot check', { cause });
      if (response.status === 404) return { status: 404, body: null };
      throw new SchemaError(PROVIDER, '5Post returned a reply that is not JSON', { cause });
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFivePostNumber(raw);
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + remainingMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      const list = await this.#get(fivePostUrls(number).orders, signal, left());
      // The list route answers every number, an empty list for one it does not know.
      if (list.status === 404) throw new TransportError(PROVIDER, '5Post no longer serves its order list');
      const orderId = fivePostOrderId(list.body, number);
      const urls = fivePostUrls(number, orderId);
      const [details, history] = await Promise.all([this.#get(urls.details, signal, left()), this.#get(urls.history, signal, left())]);
      // The order was just listed, so losing it now is no answer either way.
      if (details.status === 404 || history.status === 404) throw new IndeterminateError(PROVIDER, '5Post did not return the order it listed');
      return parseFivePost(details.body, history.body, orderId, number);
    };
    // A request that fails to reach 5Post, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: '5post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FivePostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '5post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
