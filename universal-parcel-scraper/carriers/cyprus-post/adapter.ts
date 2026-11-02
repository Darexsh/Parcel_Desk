import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CYPRUS_POST_LOOKUP, CYPRUS_POST_MAX_BYTES, CYPRUS_POST_ORIGIN, CYPRUS_POST_RESULTS, cyprusPostResultsUrl,
  isCyprusPostBlockPage, normalizeCyprusPostNumber, parseCyprusPost, parseCyprusPostForm, PROVIDER,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item, and 419 is a refused form token.
const UNAVAILABLE = [404, 410];
const EXPIRED_FORM = 419;
// Laravel's session cookie, and the load balancer's.
const SESSION_COOKIE = /^(?:[A-Za-z0-9_]{1,40}_session|cookiesession1)$/;
const COOKIE_VALUE = /^[^\s;,]{1,2048}$/;

/** The session cookies a reply sets, over those already held. */
function sessionCookies(response: Response, held = new Map<string, string>()): Map<string, string> {
  const jar = new Map(held);
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator > 0 && SESSION_COOKIE.test(name) && COOKIE_VALUE.test(value)) jar.set(name, value);
  }
  return jar;
}

const cookieHeader = (jar: Map<string, string>) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie, the form token and the signed
 * results address.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class CyprusPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCyprusPostNumber(raw);
    // One attempt opens a session on the results page, posts the number with
    // the form's token and reads the signed results page the form redirects to.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' };
      const read = (url: string, init: RequestInit) => fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
        maxBytes: CYPRUS_POST_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, EXPIRED_FORM],
        fetcher: this.options.fetcher });
      const page = (response: Response, bytes: Uint8Array, what: string): string => {
        if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, `Cyprus Post ${what} is unavailable`);
        if (response.status !== 200) throw new IndeterminateError(PROVIDER, `Cyprus Post did not answer with its ${what}`);
        return decodeText(bytes);
      };
      try {
        const form = await read(CYPRUS_POST_RESULTS, { method: 'GET', headers });
        const fields = parseCyprusPostForm(page(form.response, form.bytes, 'tracking page'));
        const jar = sessionCookies(form.response);
        if (![...jar.keys()].some(name => name.endsWith('_session'))) {
          throw new IndeterminateError(PROVIDER, 'Cyprus Post did not open an anonymous session');
        }
        signal.throwIfAborted();
        const lookup = await read(CYPRUS_POST_LOOKUP, { method: 'POST', headers: { ...headers, Cookie: cookieHeader(jar),
          'Content-Type': 'application/x-www-form-urlencoded', Origin: CYPRUS_POST_ORIGIN, Referer: CYPRUS_POST_RESULTS },
        body: new URLSearchParams({ ...fields, code: number }) });
        if (lookup.response.status === EXPIRED_FORM) {
          throw new IndeterminateError(PROVIDER, 'Cyprus Post did not accept the tracking session', { reason: 'session_rejected' });
        }
        if (!REDIRECTS.includes(lookup.response.status)) {
          const html = page(lookup.response, lookup.bytes, 'lookup');
          if (isCyprusPostBlockPage(html)) throw new ChallengeError(PROVIDER, 'Cyprus Post answered with a block page');
          throw new IndeterminateError(PROVIDER, 'Cyprus Post did not answer the lookup');
        }
        const results = cyprusPostResultsUrl(lookup.response.headers.get('location') ?? '', number);
        signal.throwIfAborted();
        const answer = await read(results, { method: 'GET', headers: { ...headers,
          Cookie: cookieHeader(sessionCookies(lookup.response, jar)), Referer: CYPRUS_POST_RESULTS } });
        return parseCyprusPost(page(answer.response, answer.bytes, 'results page'), number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cyprus-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CyprusPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cyprus-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCyprusPostNumber(number))),
  };
};
