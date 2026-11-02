import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FIRST_LINE_MAX_BYTES, normalizeFirstLineNumber, parseFirstLine, parseFirstLinePage, PROVIDER } from './parser.js';

// The tracker answers plain HTTP only.
const ORIGIN = 'http://www.firstline56.com';
/** The tracking page, which opens the session and signs the lookup's address for it. */
export const FIRST_LINE_PAGE = `${ORIGIN}/track.php`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number in its reply: a missing route is not a missing waybill.
const GONE = [404, 405, 410];
// The site's 403 for a visitor sending too many requests: "server busy, try again later".
const BUSY = /服务器繁忙/;
const COOKIES = ['PHPSESSID', 'tokenc'];
const COOKIE_VALUE = /^[A-Za-z0-9%._-]{8,512}$/;

/** The session cookies the tracking page sets, which the lookup sends back with the signed address. */
function sessionCookies(response: Response): string {
  const pairs = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (COOKIES.includes(name) && COOKIE_VALUE.test(value)) pairs.set(name, pair);
  }
  if (pairs.size !== COOKIES.length) throw new IndeterminateError(PROVIDER, 'FIRST LINE did not open an anonymous session', { reason: 'session_rejected' });
  return COOKIES.map((name) => pairs.get(name)!).join('; ');
}

/** A 403 from the site: its own throttle, or something else refusing the visitor. */
function refused(bytes: Uint8Array, what: string): never {
  if (BUSY.test(decodeText(bytes).slice(0, 4_000))) throw new RateLimitedError(PROVIDER, undefined, 'FIRST LINE asked to slow down', { status: 403 });
  throw new ChallengeError(PROVIDER, `FIRST LINE refused its ${what}`, { status: 403 });
}

export class FirstLineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFirstLineNumber(raw);
    // One attempt opens a session on the tracking page and posts the number to the address it signed, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const page = await fetchBounded(FIRST_LINE_PAGE, { method: 'GET', signal, headers: { Accept: 'text/html', 'User-Agent': userAgent } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: FIRST_LINE_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (page.response.status === 403) refused(page.bytes, 'tracking page');
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'FIRST LINE tracking page is unavailable', { status: page.response.status });
      const lookup = parseFirstLinePage(decodeText(page.bytes));
      const cookies = sessionCookies(page.response);
      signal.throwIfAborted();
      const reply = await fetchBounded(`${ORIGIN}/${lookup}`, { method: 'POST', signal, body: new URLSearchParams({ track_number: number }).toString(), headers: {
        Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgent,
        Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: FIRST_LINE_PAGE,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: FIRST_LINE_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (reply.response.status === 403) refused(reply.bytes, 'tracking lookup');
      if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'FIRST LINE tracking lookup is unavailable', { status: reply.response.status });
      return parseFirstLine(decodeText(reply.bytes), number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a new session:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'first-line', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FirstLineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'first-line', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
