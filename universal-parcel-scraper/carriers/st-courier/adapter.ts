import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, textFromHtml, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  isStCourierChallenge, normalizeStCourierNumber, parseStCourier, PROVIDER, ST_COURIER_CHECK, ST_COURIER_MAX_BYTES, ST_COURIER_RESULT,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 410];
// CodeIgniter's session cookie, which holds the number the result page shows.
const SESSION_COOKIE = /^ci_session=[^\s;,]{1,256}/;
// The lookup's refusals of a number its tracker does not take.
const REFUSED = /not in the correct format|must contain only numbers/i;

/**
 * The lookup's JSON answer: `code` 200 once the number is filed in the
 * session, 400 with the form's message for a number it refuses.
 */
function checked(body: string): void {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch (cause) {
    if (isStCourierChallenge(body)) throw new ChallengeError(PROVIDER, 'ST Courier answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'ST Courier returned a reply that is not JSON', { cause });
  }
  if (!isRecord(reply) || typeof reply.code !== 'number') throw new SchemaError(PROVIDER, 'ST Courier returned an invalid lookup reply');
  if (reply.code === 200) return;
  if (REFUSED.test(textFromHtml(reply.msg, 200))) throw new InvalidInputError(PROVIDER, 'ST Courier does not take this AWB number', { reason: 'wrong_number' });
  throw new IndeterminateError(PROVIDER, 'ST Courier did not complete the lookup');
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class StCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeStCourierNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try in
    // a fresh session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'st-courier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** The tracking form's two requests: the lookup files the number in a new session, then the result page shows it. */
  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const send = (url: string, init: RequestInit & { headers: Record<string, string> }) => fetchBounded(url, {
      ...init, signal, headers: { 'User-Agent': userAgent, ...init.headers },
    }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: ST_COURIER_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
    const answered = (response: Response, what: string) => {
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, `ST Courier moved its ${what}`);
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, `ST Courier's ${what} is unavailable`);
      if (response.status === 403) throw new ChallengeError(PROVIDER, `ST Courier refused its ${what}`, { status: 403 });
    };
    try {
      const lookup = await send(ST_COURIER_CHECK, { method: 'POST', headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }, body: new URLSearchParams({ awb_no: number }).toString() });
      answered(lookup.response, 'tracking lookup');
      checked(decodeText(lookup.bytes));
      const session = lookup.response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
      if (!session) throw new IndeterminateError(PROVIDER, 'ST Courier did not open a tracking session', { reason: 'session_rejected' });
      signal.throwIfAborted();
      const page = await send(ST_COURIER_RESULT, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml', Cookie: session } });
      answered(page.response, 'result page');
      return parseStCourier(decodeText(page.bytes), number);
    } catch (error) {
      throw withoutSession(error);
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new StCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'st-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeStCourierNumber(number))),
  };
};
