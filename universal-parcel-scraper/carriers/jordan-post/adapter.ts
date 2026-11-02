import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isJordanPostItemRedirect, JORDAN_POST_MAX_BYTES, JORDAN_POST_SEARCH, jordanPostItemUrl, jordanPostSearchFields,
  normalizeJordanPostNumber, parseJordanPostItem, parseJordanPostSearch, PROVIDER,
} from './parser.js';

export { JORDAN_POST_ITEM, JORDAN_POST_SEARCH } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class JordanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJordanPostNumber(raw);
    // One attempt opens the IPS page the tracking page's form sends an IPS
    // item to. When that page holds nothing for the code, it asks the form,
    // which also looks in Jordan Post's domestic records: it opens the form
    // and posts the code back as its search button does. None of the requests
    // needs a cookie, a token or a browser.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (url: string, init: RequestInit, redirects = false): Promise<{ html: string; location?: string }> => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: JORDAN_POST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Jordan Post tracking page is unavailable', { status: response.status });
        if (REDIRECTS.includes(response.status)) {
          const location = response.headers.get('location');
          if (!redirects || !location) throw new TransportError(PROVIDER, 'Jordan Post redirected its tracking page', { status: response.status });
          return { html: '', location };
        }
        return { html: decodeText(bytes) };
      };
      const item = parseJordanPostItem((await read(jordanPostItemUrl(number), { method: 'GET', headers })).html, number);
      if (item) return item;
      const search = await read(JORDAN_POST_SEARCH, { method: 'GET', headers });
      const answer = await read(JORDAN_POST_SEARCH, { method: 'POST', body: jordanPostSearchFields(search.html, number).toString(),
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: JORDAN_POST_SEARCH } }, true);
      if (answer.location === undefined) return parseJordanPostSearch(answer.html, number);
      // The form sends an item to the IPS page only when the IPS system holds it.
      if (isJordanPostItemRedirect(answer.location, number)) {
        throw new IndeterminateError(PROVIDER, 'Jordan Post\'s form sent the code to its IPS page, which had no information for it');
      }
      throw new TransportError(PROVIDER, 'Jordan Post redirected its tracking page');
    };
    // An attempt that fails to reach Jordan Post, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'jordan-post', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JordanPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jordan-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJordanPostNumber(number))),
  };
};
