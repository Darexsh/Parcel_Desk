import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeSpExpressNumber, parseSpExpress, parseSpExpressSearchPage, PROVIDER, SP_EXPRESS_MAX_BYTES, spExpressSearchUrl,
  spExpressTrackingUrl,
} from './parser.js';

export { spExpressTrackingUrl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number is sent back to the search page.
const GONE = [404, 410];
// PHP's session cookie, which holds the search page's notice about the number.
const SESSION_COOKIE = /^bes=[A-Za-z0-9,-]{1,128}(?=;|$)/;

export class SpExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpExpressNumber(raw);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
    const get = (url: string, signal: AbortSignal, timeoutMs: number, extra: Record<string, string> = {}) => fetchBounded(url,
      { method: 'GET', signal, headers: { ...headers, ...extra } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: SP_EXPRESS_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
    const refused = (status: number) => {
      if (GONE.includes(status)) throw new TransportError(PROVIDER, 'SP Express tracking page is unavailable', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'SP Express refused the lookup', { status });
    };
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const { response, bytes } = await get(spExpressTrackingUrl(number), signal, timeoutMs);
      refused(response.status);
      if (!REDIRECTS.includes(response.status)) return parseSpExpress(decodeText(bytes), number);
      // The tracker sends a number it has no parcel for back to its search page,
      // which shows the notice once, in the session the redirect opened.
      const search = spExpressSearchUrl(number);
      let location = '';
      try { location = new URL(response.headers.get('location') ?? '', search).href; } catch { /* no usable address */ }
      if (location.replace(/\/$/, '') !== search) throw new IndeterminateError(PROVIDER, 'SP Express sent the lookup to another page');
      const session = response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
      if (!session) throw new IndeterminateError(PROVIDER, 'SP Express sent the lookup back to its search page without a session');
      const notice = await get(search, signal, deadline - Date.now(), { Cookie: session });
      refused(notice.response.status);
      if (REDIRECTS.includes(notice.response.status)) throw new IndeterminateError(PROVIDER, 'SP Express sent its search page to another page');
      return parseSpExpressSearchPage(decodeText(notice.bytes));
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sp-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sp-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpExpressNumber(number))),
  };
};
