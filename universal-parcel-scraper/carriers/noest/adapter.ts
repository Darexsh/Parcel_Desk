import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { noestRequestNumber } from './number.js';
import { NOEST_MAX_BYTES, noestFormToken, parseNoest, PROVIDER } from './parser.js';

/** NOEST's public tracking page; its form posts back to the same address. */
export const NOEST_TRACKING = 'https://app.noest-dz.com/list/t';
// Laravel's session cookie, which the form's token belongs to.
const SESSION = /^noest_express_session=[A-Za-z0-9%._~+/=-]{1,4096}$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
// Laravel's answer to a form token its session does not hold.
const EXPIRED = 419;
const DEFAULT_BUDGET_MS = 20_000;

/** The session cookie the page sets. */
function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim()).find((part) => SESSION.test(part));
  if (!cookie) throw new SchemaError(PROVIDER, 'NOEST’s tracking page opened no session');
  return cookie;
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie and the form token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class NoestTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async request(init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; html: string; response: Response }> {
    const { response, bytes } = await fetchBounded(NOEST_TRACKING, { ...init, signal, headers: {
      ...init.headers as Record<string, string>, Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: NOEST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, EXPIRED] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'NOEST tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'NOEST refused the lookup', { status: 403 });
    return { status: response.status, html: decodeText(bytes), response };
  }

  /** The page, for its form token and session, then the form posted with the one number. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const page = await this.request({ method: 'GET' }, signal, left());
    if (page.status !== 200) throw new TransportError(PROVIDER, 'NOEST redirected its tracking page', { status: page.status });
    const token = noestFormToken(page.html);
    const cookie = sessionCookie(page.response);
    signal.throwIfAborted();
    try {
      const answer = await this.request({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ _token: token, tracking: number }).toString() }, signal, left());
      if (answer.status === EXPIRED) {
        throw new IndeterminateError(PROVIDER, 'NOEST did not accept the tracking page’s session', { status: EXPIRED, reason: 'session_rejected' });
      }
      if (REDIRECTS.includes(answer.status)) throw new SchemaError(PROVIDER, 'NOEST redirected the tracking form', { status: answer.status });
      return parseNoest(answer.html, number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = noestRequestNumber(raw);
    // A lookup that fails to reach NOEST, or hangs, starts again with a new
    // page once: the first try gets half of the budget.
    return runSteps({ carrier: 'noest', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NoestTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'noest', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => noestRequestNumber(number))),
  };
};
