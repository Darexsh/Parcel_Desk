import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isTanzaniaPostsErrorPage, normalizeTanzaniaPostsNumber, parseTanzaniaPostsReply, PROVIDER, TANZANIA_POSTS_LOOKUP, TANZANIA_POSTS_MAX_BYTES,
  TANZANIA_POSTS_TRACKER,
} from './parser.js';

export { TANZANIA_POSTS_LOOKUP } from './parser.js';

const ORIGIN = new URL(TANZANIA_POSTS_LOOKUP).origin;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item.
const GONE = [404, 410];
const SERVER_ERROR = 500;
// The tracker takes a few seconds to answer, found or not.
const DEFAULT_BUDGET_MS = 30_000;

export class TanzaniaPostsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTanzaniaPostsNumber(raw);
    // The search form posts the code alone, as the page's script does. No
    // session, token, key or browser is needed.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(TANZANIA_POSTS_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: TANZANIA_POSTS_TRACKER, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ code: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: TANZANIA_POSTS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, SERVER_ERROR] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Tanzania Posts Corporation redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Tanzania Posts Corporation’s tracking lookup is unavailable', { status: response.status });
      const body = decodeText(bytes);
      if (response.status === SERVER_ERROR) {
        if (isTanzaniaPostsErrorPage(body)) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation’s tracker failed with its error page', { status: SERVER_ERROR });
        throw new IndeterminateError(PROVIDER, 'Tanzania Posts Corporation’s tracker failed', { status: SERVER_ERROR });
      }
      return parseTanzaniaPostsReply(body, number);
    };
    // A read that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'tanzania-posts', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TanzaniaPostsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tanzania-posts', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
