import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CHIT_CHATS_MAX_BYTES, CHIT_CHATS_ORIGIN, isChitChatsBlockPage, isSearchRedirect, normalizeChitChatsNumber, parseChitChats, parseChitChatsSearch, PROVIDER,
} from './parser.js';

// The search page. A shipment's page is under it, and its JSON, which Chit
// Chats' API documentation describes, adds `.json` to that page's address.
export const CHIT_CHATS_SEARCH = `${CHIT_CHATS_ORIGIN}/tracking`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: Chit Chats redirects unknown IDs.
const GONE = [404, 410];
// The Rails session that carries the search page's notice.
const SESSION_COOKIE = '_chitchats_session';
const COOKIE_VALUE = /^[^\s;,]{1,4096}$/;

export function chitChatsJsonUrl(raw: string): string {
  return `${CHIT_CHATS_SEARCH}/${normalizeChitChatsNumber(raw)}.json`;
}

/** The session cookie a redirect sets, or an empty string. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const value = pair.slice(separator + 1);
    if (pair.slice(0, separator) === SESSION_COOKIE && COOKIE_VALUE.test(value)) return `${SESSION_COOKIE}=${value}`;
  }
  return '';
}

/** The same failure without the request details fetchBounded attaches: they hold the session cookie. */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class ChitChatsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChitChatsNumber(raw);
    const url = chitChatsJsonUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      // A known shipment answers with its JSON; an unknown one redirects to the
      // search page, so redirects are read rather than followed.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgent,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CHIT_CHATS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (GONE.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Chit Chats tracking page is unavailable');
      if (REDIRECTS.includes(response.status)) {
        if (!isSearchRedirect(response.headers.get('location'))) throw new IndeterminateError(PROVIDER, 'Chit Chats moved the lookup elsewhere');
        const cookie = sessionCookie(response);
        if (!cookie) throw new IndeterminateError(PROVIDER, 'Chit Chats sent the lookup to its search page without a session');
        signal.throwIfAborted();
        // The notice the redirect leaves in the session says why.
        try {
          const search = await fetchBounded(CHIT_CHATS_SEARCH, { method: 'GET', signal, headers: {
            Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': userAgent, Cookie: cookie,
          } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CHIT_CHATS_MAX_BYTES, redirect: 'manual',
            allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
          if (search.response.status !== 200) throw new IndeterminateError(PROVIDER, 'Chit Chats did not show its search page');
          return parseChitChatsSearch(decodeText(search.bytes), number);
        } catch (error) {
          throw withoutSession(error);
        }
      }
      const body = decodeText(bytes);
      let reply: unknown;
      try {
        reply = JSON.parse(body);
      } catch (error) {
        if (isChitChatsBlockPage(body)) throw new ChallengeError(PROVIDER, 'Chit Chats answered with a block page', { cause: error });
        throw new SchemaError(PROVIDER, 'Chit Chats returned a reply that is not JSON', { cause: error });
      }
      return parseChitChats(reply, number);
    };
    // A request that fails to reach Chit Chats, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'chit-chats', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ChitChatsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'chit-chats', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChitChatsNumber(number))),
  };
};
