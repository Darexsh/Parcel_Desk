import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  LEOPARDS_LOOKUP, LEOPARDS_MAX_BYTES, LEOPARDS_ORIGIN, LEOPARDS_VIEW, normalizeLeopardsNumber, parseLeopards, PROVIDER, readLeopardsLookup,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Laravel's session cookie, which holds the consignment the lookup found.
const SESSION_COOKIE = /^leopards_official_session=([^\s;,]{1,4096})/;

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class LeopardsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLeopardsNumber(raw);
    // The tracking box's lookup keeps the consignment in a new session, and the tracking page shows it.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const get = (url: string, headers: Record<string, string>) => fetchBounded(url, { method: 'GET', signal,
        headers: { 'User-Agent': userAgentOf(this.options.userAgent), 'Accept-Language': 'en', ...headers } },
      { provider: PROVIDER, timeoutMs: left(), maxBytes: LEOPARDS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE] });
      const answered = (response: Response, what: string) => {
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, `Leopards moved its ${what}`);
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, `Leopards ${what} is unavailable`);
      };
      try {
        const lookup = await get(`${LEOPARDS_LOOKUP}?${new URLSearchParams({ cn_number: number })}`, {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: `${LEOPARDS_ORIGIN}/` });
        answered(lookup.response, 'tracking lookup');
        readLeopardsLookup(decodeText(lookup.bytes), number);
        const session = lookup.response.headers.getSetCookie().map(cookie => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
        if (!session) throw new IndeterminateError(PROVIDER, 'Leopards did not open a tracking session', { reason: 'session_rejected' });
        signal.throwIfAborted();
        const page = await get(LEOPARDS_VIEW, { Accept: 'text/html,application/xhtml+xml', Cookie: session, Referer: `${LEOPARDS_ORIGIN}/` });
        answered(page.response, 'tracking page');
        return parseLeopards(decodeText(page.bytes), raw);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    return runSteps({ carrier: 'leopards-courier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LeopardsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'leopards-courier', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLeopardsNumber(number))),
  };
};
