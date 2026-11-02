import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { SECTIGO_DV_R36 } from '../homexpress/certificate.js';
import {
  CARRIER, EXPRESS_ONE_BG_MAX_BYTES, normalizeExpressOneBgNumber, parseExpressOneBg, PROVIDER, readExpressOneBgToken,
} from './parser.js';

/** The English tracking page, whose form posts a number to its own address followed by the number. */
export const EXPRESS_ONE_BG_TRACKING = 'https://expressone.bg/en/tracking';
const ORIGIN = 'https://expressone.bg';
const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 405, 410];
// Symfony's form answers a token outside the page's session with HTTP 422.
const REFUSED = 422;
// The session cookie the form token belongs to.
const SESSION_COOKIE = /^PHPSESSID=[A-Za-z0-9,-]{16,128}(?=;|$)/;
// The site sends its certificate without the intermediate, which Node does not fetch itself.
let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([SECTIGO_DV_R36]);

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie and the form token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class ExpressOneBgTracker {
  readonly #fetcher: typeof fetch;

  /** Over the global fetch, the site is read trusting the intermediate its certificate needs; a host's own fetcher is used as given. */
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    this.#fetcher = transportOf(options.fetcher) === undefined ? trustingFetch() : options.fetcher!;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExpressOneBgNumber(raw);
    const lookup = `${EXPRESS_ONE_BG_TRACKING}/${number}`;
    // The tracking page opens a session and carries the form's token for it;
    // the form posts the number with the token, as the page's Track button does.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const request = (url: string, init: RequestInit) => fetchBounded(url, { ...init, signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: EXPRESS_ONE_BG_MAX_BYTES, redirect: 'manual', fetcher: this.#fetcher,
        allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403, REFUSED] });
      const answered = (response: Response, what: string) => {
        if (response.status === 403) throw new ChallengeError(PROVIDER, `Express One Bulgaria refused its ${what}`, { status: 403 });
        if (REDIRECTS.includes(response.status) || UNAVAILABLE.includes(response.status)) {
          throw new TransportError(PROVIDER, `Express One Bulgaria's ${what} is unavailable`, { status: response.status });
        }
      };
      try {
        const page = await request(EXPRESS_ONE_BG_TRACKING, { method: 'GET' });
        answered(page.response, 'tracking page');
        if (page.response.status === REFUSED) throw new TransportError(PROVIDER, 'Express One Bulgaria\'s tracking page is unavailable', { status: REFUSED });
        const token = readExpressOneBgToken(decodeText(page.bytes));
        const session = page.response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
        if (!session) throw new IndeterminateError(PROVIDER, 'Express One Bulgaria did not open a tracking session', { reason: 'session_rejected' });
        signal.throwIfAborted();
        const answer = await request(lookup, { method: 'POST', headers: {
          'Content-Type': 'application/x-www-form-urlencoded', Cookie: session, Origin: ORIGIN, Referer: lookup,
        }, body: new URLSearchParams({ 'form[bols]': number, 'form[_token]': token }).toString() });
        answered(answer.response, 'tracking form');
        // The form refused the token: the page's "No results found" then says nothing about the number.
        if (answer.response.status === REFUSED) {
          throw new IndeterminateError(PROVIDER, 'Express One Bulgaria did not accept the tracking session', { reason: 'session_rejected' });
        }
        return parseExpressOneBg(decodeText(answer.bytes), number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // A read that fails to reach the site, or hangs, gets one more try in a
    // session of its own: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExpressOneBgTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeExpressOneBgNumber(number))),
  };
};
