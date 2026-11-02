import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRoyalExpressNumber, parseRoyalExpress, PROVIDER, ROYAL_EXPRESS_MAX_BYTES, royalExpressFormToken } from './parser.js';

/** Royal Express's tracking page; its form posts back to the same address. */
export const ROYAL_EXPRESS_TRACKING = 'https://royalx.net/tracking';
const SESSION = /^royal_express_session=[A-Za-z0-9%._~+/=-]{1,4096}$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
// Laravel's answer to a form token its session does not hold.
const EXPIRED = 419;
const DEFAULT_BUDGET_MS = 15_000;

/** The session cookie the page sets, which the form's token is bound to. */
function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim()).find((part) => SESSION.test(part));
  if (!cookie) throw new SchemaError(PROVIDER, 'Royal Express’s tracking page set no session');
  return cookie;
}

export class RoyalExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async request(init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; html: string; response: Response }> {
    const { response, bytes } = await fetchBounded(ROYAL_EXPRESS_TRACKING, { ...init, signal, headers: {
      ...init.headers as Record<string, string>, Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ROYAL_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, EXPIRED] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Royal Express tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Royal Express refused the lookup', { status: 403 });
    return { status: response.status, html: decodeText(bytes), response };
  }

  /** The page, for its form token and session, then the form posted with the waybill. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const page = await this.request({ method: 'GET' }, signal, left());
    if (page.status !== 200) throw new TransportError(PROVIDER, 'Royal Express did not serve its tracking page', { status: page.status });
    const token = royalExpressFormToken(page.html);
    const cookie = sessionCookie(page.response);
    const answer = await this.request({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _token: token, 'waybill-number': number }).toString() }, signal, left());
    // A token the session does not hold expires the form; a form the tracker
    // will not take is sent back to the page.
    if (answer.status === EXPIRED) throw new SchemaError(PROVIDER, 'Royal Express refused the tracking page’s form token', { status: EXPIRED });
    if (REDIRECTS.includes(answer.status)) throw new SchemaError(PROVIDER, 'Royal Express sent the tracking form back', { status: answer.status });
    return parseRoyalExpress(answer.html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRoyalExpressNumber(raw);
    // A lookup that fails to reach Royal Express, or hangs, starts again with
    // a new page once: the first try gets half of the budget. An HTTP status,
    // a rate limit included, is never sent again.
    return runSteps({ carrier: 'royal-express-mm', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RoyalExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'royal-express-mm', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRoyalExpressNumber(number))),
  };
};
