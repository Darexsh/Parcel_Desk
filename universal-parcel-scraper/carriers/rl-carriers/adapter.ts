import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRlNumber, parseRlCarriers, parseRlRefusal, PROVIDER, RL_MAX_BYTES } from './parser.js';

export { normalizeRlNumber, parseRlCarriers, parseRlRefusal, rlSearchErrors } from './parser.js';

const ORIGIN = 'https://www.rlcarriers.com';
// The shipment tracing page, which answers its own form without an account,
// token, anti-forgery field or CAPTCHA.
const SEARCH = '/freight/shipping/shipment-tracing';
export const RL_TRACING_URL = `${ORIGIN}${SEARCH}`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment.
const GONE = [404, 410];
const SESSION = /^ASP\.NET_SessionId=([A-Za-z0-9]{1,128})(?:;|$)/;
// The firewall's page in place of the tracer, which it sends with HTTP 200.
const REJECTED = /The requested URL was rejected|<title>\s*Request Rejected/i;

/** The address the tracing form posts one PRO number to, which also opens its result. */
export function rlTracingUrl(raw: string): string {
  const url = new URL(RL_TRACING_URL);
  url.search = new URLSearchParams({ pro: normalizeRlNumber(raw), docType: 'PRO', source: 'web' }).toString();
  return url.href;
}

/** The anonymous session a refused search opens, which holds the page's message. */
function sessionCookie(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const match = SESSION.exec(header);
    if (match) return `ASP.NET_SessionId=${match[1]}`;
  }
  return null;
}

/** Whether a redirect leads back to the search page on R+L's own host. */
function toSearch(response: Response): boolean {
  const location = response.headers.get('location');
  if (!location) return false;
  try {
    const target = new URL(location, `${ORIGIN}/`);
    return target.origin === ORIGIN && target.pathname === SEARCH && !target.search;
  } catch {
    return false;
  }
}

/** The same failure without the request and response details fetchBounded attaches: they hold the session cookie. */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class RlCarriersTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRlNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    // A request that fails to reach R+L, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'rl-carriers', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.lookup(number, signal, firstAttemptMs(remainingMs), budgetMs) },
      networkRetryStep(({ signal, remainingMs }) => this.lookup(number, signal, remainingMs, budgetMs)),
    ]);
  }

  private async lookup(number: string, signal: AbortSignal, timeoutMs: number, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const userAgent = userAgentOf(this.options.userAgent);
    const read = async (url: string, init: { method: 'GET' | 'POST'; body?: URLSearchParams; cookie?: string }) => {
      const left = deadline - performance.now();
      if (left <= 0) throw new BudgetExceededError(PROVIDER, budgetMs);
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(url, { method: init.method, signal, body: init.body, headers: {
        Accept: 'text/html', 'User-Agent': userAgent, ...(init.cookie ? { Cookie: init.cookie } : {}),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(left)), maxBytes: RL_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      signal.throwIfAborted();
      if (GONE.includes(response.status)) throw new IndeterminateError(PROVIDER, 'R+L Carriers shipment tracing is unavailable');
      return { response, html: decodeText(bytes) };
    };

    // The page's own form: it posts the number to the address that also opens the result.
    const search = await read(rlTracingUrl(number), { method: 'POST', body: new URLSearchParams({ Type: 'PRO', TrackingNumbers: number }) });
    if (REDIRECTS.includes(search.response.status)) {
      // A refused search sends the browser back to the search page, whose
      // message sits in the session the refusal opened.
      const cookie = sessionCookie(search.response);
      if (!toSearch(search.response) || !cookie) throw new IndeterminateError(PROVIDER, 'R+L Carriers redirected the PRO search');
      let page;
      try {
        page = await read(RL_TRACING_URL, { method: 'GET', cookie });
      } catch (error) {
        throw withoutSession(error);
      }
      if (REDIRECTS.includes(page.response.status)) throw new IndeterminateError(PROVIDER, 'R+L Carriers did not show the search page');
      if (REJECTED.test(page.html)) throw new ChallengeError(PROVIDER, 'R+L Carriers answered with a block page');
      return parseRlRefusal(page.html, number);
    }
    if (!search.html.includes('id="shipment_list"')) {
      if (REJECTED.test(search.html)) throw new ChallengeError(PROVIDER, 'R+L Carriers answered with a block page');
      throw new SchemaError(PROVIDER, 'R+L Carriers returned a page without its shipment list');
    }
    return parseRlCarriers(search.html, number);
  }
}

/**
 * Recognition uses the same lookup. A shipment the tracer finds under another
 * PRO does not show that the number asked is one of R+L's.
 */
async function recognizedLookup(tracker: RlCarriersTracker, number: string, context?: TrackingContext): Promise<CarrierResult> {
  const result = await tracker.fetch(number, context);
  if (result.canonical_tracking_number) throw new IndeterminateError(PROVIDER, 'R+L Carriers answered with the shipment of another PRO');
  return result;
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RlCarriersTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'rl-carriers', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => recognizedLookup(tracker, number, context),
      () => accepted(() => normalizeRlNumber(number))),
  };
};
