import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isKyrgyzPostBlockPage, KYRGYZ_POST_MAX_BYTES, normalizeKyrgyzPostNumber, parseKyrgyzPostReply, PROVIDER } from './parser.js';

/** The tracking page on post.kg, whose script posts the number to the lookup. */
export const KYRGYZ_POST_PAGE = 'https://post.kg/language/ru/treking-posylok/';
/** The WordPress action endpoint the tracking page's script posts the number to. */
export const KYRGYZ_POST_LOOKUP = 'https://post.kg/wp-admin/admin-ajax.php';
const ORIGIN = new URL(KYRGYZ_POST_LOOKUP).origin;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item.
const GONE = [404, 410];
// WordPress answers an action it does not have with HTTP 400 and "0".
const NO_ACTION = 400;

export class KyrgyzPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKyrgyzPostNumber(raw);
    // The form post the page's script sends: the action and the code, with no
    // cookie, token, key or browser.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(KYRGYZ_POST_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: KYRGYZ_POST_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ action: 'get_track_number', barcode: number }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KYRGYZ_POST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, NO_ACTION] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Kyrgyz Post redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Kyrgyz Post’s tracking lookup is unavailable', { status: response.status });
      const body = decodeText(bytes);
      if (response.status === NO_ACTION) {
        if (isKyrgyzPostBlockPage(body)) throw new ChallengeError(PROVIDER, 'Kyrgyz Post answered with a block page', { status: NO_ACTION });
        throw new TransportError(PROVIDER, 'Kyrgyz Post’s site no longer has its tracking lookup', { status: NO_ACTION });
      }
      return parseKyrgyzPostReply(body, number);
    };
    // A read that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'kyrgyz-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KyrgyzPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kyrgyz-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKyrgyzPostNumber(number))),
  };
};
