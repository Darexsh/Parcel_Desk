import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  BOOKURIER_API, BOOKURIER_MAX_BYTES, BOOKURIER_PAGE, isBookurierChallenge, normalizeBookurierNumber, parseBookurier, PROVIDER, readBookurierToken,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 410];
// CodeIgniter's session cookie, which the page's lookup token belongs to.
const SESSION_COOKIE = /^ci_session=[^\s;,]{1,256}/;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBookurierChallenge(body)) throw new ChallengeError(PROVIDER, 'Bookurier answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Bookurier returned a reply that is not JSON', { cause });
  }
}

/** Whether a refusal says the session expired, which the page answers by reloading its token. */
function expired(body: string): boolean {
  try {
    const reply: unknown = JSON.parse(body);
    return isRecord(reply) && reply.token_expired === true;
  } catch {
    return false;
  }
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie and the lookup token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class BookurierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBookurierNumber(raw);
    // The tracking page opens a session and carries a token for one lookup in it.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const get = (url: string, headers: Record<string, string>) => fetchBounded(url, { method: 'GET', signal,
        headers: { 'User-Agent': userAgentOf(this.options.userAgent), 'Accept-Language': 'ro', ...headers } },
      { provider: PROVIDER, timeoutMs: left(), maxBytes: BOOKURIER_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
      const answered = (response: Response, what: string) => {
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, `Bookurier moved its ${what}`);
        if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, `Bookurier's ${what} is unavailable`);
      };
      try {
        const page = await get(BOOKURIER_PAGE, { Accept: 'text/html,application/xhtml+xml' });
        answered(page.response, 'tracking page');
        if (page.response.status === 403) throw new ChallengeError(PROVIDER, 'Bookurier refused its tracking page', { status: 403 });
        const token = readBookurierToken(decodeText(page.bytes));
        const session = page.response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
        if (!session) throw new IndeterminateError(PROVIDER, 'Bookurier did not open a tracking session', { reason: 'session_rejected' });
        signal.throwIfAborted();
        const lookup = await get(`${BOOKURIER_API}?${new URLSearchParams({ awb: number, _token: token })}`, {
          Accept: 'application/json, */*;q=0.8', 'X-Track-Token': token, Cookie: session, Referer: BOOKURIER_PAGE });
        answered(lookup.response, 'tracking lookup');
        const body = decodeText(lookup.bytes);
        if (lookup.response.status === 403) {
          if (expired(body)) throw new IndeterminateError(PROVIDER, 'Bookurier did not accept the tracking session', { reason: 'session_rejected' });
          throw new ChallengeError(PROVIDER, 'Bookurier refused the lookup', { status: 403 });
        }
        return parseBookurier(json(body), number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    return runSteps({ carrier: 'bookurier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BookurierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bookurier', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
