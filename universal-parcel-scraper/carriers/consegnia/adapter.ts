import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, CONSEGNIA_MAX_BYTES, consegniaJson, consegniaToken, isBlockPage, isUnknownShipment, normalizeConsegniaNumber, parseConsegnia, PROVIDER,
} from './parser.js';

const ORIGIN = 'https://clc-express.com';
/** The tracking page, which opens the session its lookup needs and carries the session's token. */
export const CONSEGNIA_PAGE = `${ORIGIN}/track-delivery`;
/** The lookup the tracking page's script posts the number to. */
export const CONSEGNIA_LOOKUP = `${ORIGIN}/track-delivery-result`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown number with its own HTTP 404; any other is a missing route.
const GONE = [404, 410];
// Laravel's refusal of a token or session it did not issue, or one that expired.
const REFUSED_SESSION = 419;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const COOKIE_VALUE = /^[^\s;,]{1,4096}$/;
const MAX_COOKIES = 8;
const DEFAULT_BUDGET_MS = 15_000;

/**
 * The cookies the tracking page sets, as the lookup sends them back: Laravel's
 * session, its token cookie and the site's own. Null without the session.
 */
function sessionCookies(response: Response): string | null {
  const pairs: string[] = [];
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    if (separator > 0 && COOKIE_NAME.test(name) && COOKIE_VALUE.test(pair.slice(separator + 1)) && pairs.length < MAX_COOKIES) pairs.push(pair);
  }
  return pairs.some((pair) => /^[^=]+_session=/.test(pair)) ? pairs.join('; ') : null;
}

export class ConsegniaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeConsegniaNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // One attempt opens a session on the tracking page and posts the number with its token, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const page = await fetchBounded(CONSEGNIA_PAGE, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CONSEGNIA_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (page.response.status === 403) throw new ChallengeError(PROVIDER, 'Consegnia refused its tracking page', { status: 403 });
      if (page.response.status !== 200) {
        throw new TransportError(PROVIDER, 'Consegnia tracking page is unavailable', { status: page.response.status });
      }
      const html = decodeText(page.bytes);
      const token = consegniaToken(html);
      if (!token) {
        if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Consegnia answered the tracking page with a browser check');
        throw new SchemaError(PROVIDER, 'Consegnia tracking page carries no lookup token');
      }
      const cookie = sessionCookies(page.response);
      if (!cookie) throw new SchemaError(PROVIDER, 'Consegnia tracking page opened no session');

      const lookup = await fetchBounded(CONSEGNIA_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgent, Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: CONSEGNIA_PAGE,
      }, body: new URLSearchParams({ _token: token, awb_number: number }).toString() }, { provider: PROVIDER, timeoutMs: left(),
        maxBytes: CONSEGNIA_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403, REFUSED_SESSION],
        fetcher: this.options.fetcher });
      const { status } = lookup.response;
      const body = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
      if (REDIRECTS.includes(status) || status === 410) throw new TransportError(PROVIDER, 'Consegnia tracking lookup is unavailable', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Consegnia refused the lookup', { status });
      // The session the page just opened was refused: it says nothing about the shipment.
      if (status === REFUSED_SESSION) throw new IndeterminateError(PROVIDER, 'Consegnia refused the tracking page’s session', { status });
      if (status === 404) {
        if (isUnknownShipment(body)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Consegnia tracking lookup is unavailable', { status });
      }
      return parseConsegnia(consegniaJson(body), number);
    };
    // An attempt that fails to reach Consegnia, or hangs, gets one more in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ConsegniaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeConsegniaNumber(number))),
  };
};
