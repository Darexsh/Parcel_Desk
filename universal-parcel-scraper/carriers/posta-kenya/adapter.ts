import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isPostaKenyaErrorPage, normalizePostaKenyaNumber, parsePostaKenyaAnswer, parsePostaKenyaResult, POSTA_KENYA_MAX_BYTES, POSTA_KENYA_TRACK,
  postaKenyaFormFields, PROVIDER,
} from './parser.js';

export { POSTA_KENYA_TRACK } from './parser.js';

const ORIGIN = new URL(POSTA_KENYA_TRACK).origin;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item.
const GONE = [404, 410];
const SERVER_ERROR = 500;
// The form takes several seconds to answer for an item the tracker holds.
const DEFAULT_BUDGET_MS = 30_000;
// ASP.NET's session cookie, which holds the lookup for the result page.
const SESSION_COOKIE = 'ASP.NET_SessionId';
const COOKIE_VALUE = /^[A-Za-z0-9]{1,128}$/;

/** The session cookie a reply sets, else the one already held. */
function sessionCookie(response: Response, held: string | null = null): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const value = pair.slice(separator + 1);
    if (pair.slice(0, separator) === SESSION_COOKIE && COOKIE_VALUE.test(value)) return `${SESSION_COOKIE}=${value}`;
  }
  return held;
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie, which opens the item's result page,
 * its addressee and its proof of delivery to whoever holds it.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class PostaKenyaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaKenyaNumber(raw);
    // One attempt opens the tracking page's form, posts the code back with the
    // form's state and reads the result page the answer opens, in the session
    // the answer set. No token, key or browser is needed.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (url: string, init: RequestInit): Promise<{ response: Response; html: string }> => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: POSTA_KENYA_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
          allowHttpStatuses: [...REDIRECTS, ...GONE, SERVER_ERROR] });
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Posta Kenya tracking page is unavailable', { status: response.status });
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Posta Kenya redirected its tracking page', { status: response.status });
        const html = decodeText(bytes);
        if (response.status === SERVER_ERROR) {
          if (isPostaKenyaErrorPage(html)) throw new SchemaError(PROVIDER, 'Posta Kenya’s tracker failed with its error page', { status: SERVER_ERROR });
          throw new IndeterminateError(PROVIDER, 'Posta Kenya’s tracker failed', { status: SERVER_ERROR });
        }
        return { response, html };
      };
      try {
        const form = await read(POSTA_KENYA_TRACK, { method: 'GET', headers });
        const fields = postaKenyaFormFields(form.html, number);
        const opened = sessionCookie(form.response);
        const answer = await read(POSTA_KENYA_TRACK, { method: 'POST', body: fields.toString(), headers: { ...headers,
          'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: POSTA_KENYA_TRACK, ...(opened ? { Cookie: opened } : {}) } });
        const page = parsePostaKenyaAnswer(answer.html, number);
        const session = sessionCookie(answer.response, opened);
        if (!session) throw new IndeterminateError(PROVIDER, 'Posta Kenya did not open a session for the result page', { reason: 'session_lost' });
        const result = await read(page, { method: 'GET', headers: { ...headers, Cookie: session, Referer: POSTA_KENYA_TRACK } });
        return parsePostaKenyaResult(result.html, number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a
    // new session: the first gets half of the budget, so the retry fits in the
    // rest. An HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'posta-kenya', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaKenyaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-kenya', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
