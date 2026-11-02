import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isKitChallenge, isKitNotFound, isKitTrackingPage, KIT_MAX_BYTES, KIT_PAGE_MAX_BYTES, kitCsrf, normalizeKitNumber, parseKit, PROVIDER,
} from './parser.js';

const ORIGIN = 'https://tk-kit.ru';
/** The tracking page, which opens the session its lookup needs. */
export const KIT_PAGE = `${ORIGIN}/tracking`;
/** The lookup the tracking page's script posts the number to. */
export const KIT_LOOKUP = `${ORIGIN}/site/trackload_end?send=1`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown number with its own HTTP 404; any other is a missing route.
const GONE = [404, 410];
const COOKIE_VALUE = /^[^\s;,]{1,2048}$/;
// Yii's refusal of a token or cookie it did not issue: "Unable to verify your data submission."
const REFUSED_SESSION = /Не удалось проверить переданные данные|Unable to verify your data submission/i;

/** The page's cookie that holds the other half of its token, named like the token's form field. */
function sessionCookie(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    const separator = pair.indexOf('=');
    if (pair.slice(0, separator) === name && COOKIE_VALUE.test(pair.slice(separator + 1))) return pair;
  }
  return null;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isKitChallenge(body)) throw new ChallengeError(PROVIDER, 'TK KIT answered with a browser check', { cause });
    if (isKitTrackingPage(body)) throw new SchemaError(PROVIDER, 'TK KIT answered the lookup with its tracking page', { cause });
    throw new SchemaError(PROVIDER, 'TK KIT returned a reply that is not JSON', { cause });
  }
}

export class KitTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKitNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // One attempt opens a session on the tracking page and posts the number with its token, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const page = await fetchBounded(KIT_PAGE, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: KIT_PAGE_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (page.response.status !== 200) {
        throw new TransportError(PROVIDER, 'TK KIT tracking page is unavailable', { status: page.response.status });
      }
      const html = decodeText(page.bytes);
      const csrf = kitCsrf(html);
      if (!csrf) {
        if (isKitChallenge(html)) throw new ChallengeError(PROVIDER, 'TK KIT answered the tracking page with a browser check');
        throw new SchemaError(PROVIDER, 'TK KIT tracking page carries no lookup token');
      }
      const cookie = sessionCookie(page.response, csrf.param);
      if (!cookie) throw new SchemaError(PROVIDER, 'TK KIT tracking page opened no session');

      // The page's own request: no captcha answer goes with it.
      const lookup = await fetchBounded(KIT_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgent, Cookie: cookie, 'X-CSRF-Token': csrf.token, 'X-Requested-With': 'XMLHttpRequest',
        Origin: ORIGIN, Referer: KIT_PAGE,
      }, body: new URLSearchParams([
        [csrf.param, csrf.token], ['TrackLoadForm[track_code]', number], ['TrackLoadForm[skip_converter]', '0'],
      ]).toString() }, { provider: PROVIDER, timeoutMs: left(), maxBytes: KIT_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE, 400], fetcher: this.options.fetcher });
      const { status } = lookup.response;
      const body = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
      if (REDIRECTS.includes(status) || status === 410) throw new TransportError(PROVIDER, 'TK KIT tracking lookup is unavailable', { status });
      if (status === 400) {
        // The session the page just opened was refused: a fresh one is the only remedy.
        if (REFUSED_SESSION.test(body.slice(0, 4_000))) throw new IndeterminateError(PROVIDER, 'TK KIT refused the tracking page’s session', { status });
        if (isKitChallenge(body)) throw new ChallengeError(PROVIDER, 'TK KIT answered the lookup with a browser check', { status });
        throw new SchemaError(PROVIDER, 'TK KIT refused the lookup request', { status });
      }
      if (status === 404) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(body);
        } catch {
          // A page instead of the lookup's own answer: the route has moved.
        }
        if (isKitNotFound(payload)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'TK KIT tracking lookup is unavailable', { status });
      }
      return parseKit(json(body), number);
    };
    // An attempt that fails to reach KIT, or hangs, gets one more in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'kit-tk', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KitTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kit-tk', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKitNumber(number))),
  };
};
