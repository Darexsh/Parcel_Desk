import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isHomeRedirect, normalizeParcelAbcNumber, PARCELABC_MAX_BYTES, PARCELABC_ORIGIN, parcelAbcCode, parseParcelAbc, parseParcelAbcHome, PROVIDER,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is a moved route, not a missing order: the tracker redirects unknown codes.
const GONE = [404, 410];
const COOKIE = /^([A-Za-z0-9_-]{1,64})=([^\s;,]{0,4096})$/;
const DEFAULT_BUDGET_MS = 20_000;

/** The tracking page of one order, with the hyphen the tracker needs. */
export function parcelAbcTrackingUrl(number: string): string {
  return `${PARCELABC_ORIGIN}/track/${parcelAbcCode(number)}`;
}

/** The cookies a redirect sets, which carry the session and its notice, as one Cookie header. */
function sessionCookies(response: Response): string {
  const pairs = response.headers.getSetCookie().map((header) => COOKIE.exec(header.split(';', 1)[0]!.trim()))
    .filter((pair): pair is RegExpExecArray => pair !== null);
  return pairs.some((pair) => pair[1] === 'PHPSESSID' && pair[2]) ? pairs.map((pair) => pair[0]).join('; ') : '';
}

/** The same failure without the request details fetchBounded attaches: they hold the session cookie. */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class ParcelAbcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) };
    const options = { provider: PROVIDER, maxBytes: PARCELABC_MAX_BYTES, redirect: 'manual' as const, fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE] };
    // A known order answers with its page; an unknown code is redirected to the
    // home page, so redirects are read rather than followed.
    const { response, bytes } = await fetchBounded(parcelAbcTrackingUrl(number), { method: 'GET', signal, headers }, { ...options, timeoutMs: left() });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'ParcelABC tracking page moved', { status: response.status });
    if (!REDIRECTS.includes(response.status)) return parseParcelAbc(decodeText(bytes), number);
    if (!isHomeRedirect(response.headers.get('location'))) throw new TransportError(PROVIDER, 'ParcelABC moved the lookup elsewhere', { status: response.status });
    const cookie = sessionCookies(response);
    if (!cookie) throw new IndeterminateError(PROVIDER, 'ParcelABC sent the lookup to its home page without a session');
    signal.throwIfAborted();
    // The notice the redirect leaves in the new session says why.
    try {
      const home = await fetchBounded(`${PARCELABC_ORIGIN}/`, { method: 'GET', signal, headers: { ...headers, Cookie: cookie } },
        { ...options, timeoutMs: left() });
      if (home.response.status !== 200) throw new IndeterminateError(PROVIDER, 'ParcelABC did not show its home page');
      return parseParcelAbcHome(decodeText(home.bytes));
    } catch (error) {
      throw withoutSession(error);
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeParcelAbcNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ParcelAbcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
