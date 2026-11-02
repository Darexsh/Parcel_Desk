import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JS_EXPRESS_MAX_BYTES, jsExpressReply, normalizeJsExpressNumber, parseJsExpress, PROVIDER } from './parser.js';

/** The English tracking page, whose script posts the number to the lookup as `card_num`. */
export const JS_EXPRESS_PAGE = 'https://www.js-exp.com/EN/index.php?page=19';
/** The lookup that page makes. It answers JSON, with the destination courier's number. */
export const JS_EXPRESS_TRACKER = 'https://www.js-exp.com/EN/index.php?c=trace';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the lookup answers unknown numbers itself.
const GONE = [404, 410];

export class JsExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJsExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(JS_EXPRESS_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded',
        // The lookup refuses a request whose referrer is not the tracking page, and then answers anyway.
        Referer: JS_EXPRESS_PAGE, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ card_num: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: JS_EXPRESS_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'JS Express sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The JS Express tracker is unavailable', { status: response.status });
      return parseJsExpress(jsExpressReply(decodeText(bytes)), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'js-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JsExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'js-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJsExpressNumber(number))),
  };
};
