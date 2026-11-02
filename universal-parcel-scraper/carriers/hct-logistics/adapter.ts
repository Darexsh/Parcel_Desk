import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HCT_MAX_BYTES, HCT_SEARCH, hctResultUrl, hctSearchFields, normalizeHctNumber, parseHct, PROVIDER } from './parser.js';

export { HCT_RESULT, HCT_SEARCH } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class HctTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHctNumber(raw);
    // One attempt opens the search page HCT's app shows, posts the number back
    // as its search button does, and opens the result page the answer points
    // to. None of the three needs a cookie, a picture code or a browser.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (url: string, init: RequestInit): Promise<string> => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: HCT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
        // The pages answer every number with HTTP 200; a redirect or a 404 is a moved route or an error page.
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'HCT redirected its tracking page');
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'HCT tracking page is unavailable');
        return decodeText(bytes);
      };
      const search = await read(HCT_SEARCH, { method: 'GET', headers });
      const answer = await read(HCT_SEARCH, { method: 'POST', body: hctSearchFields(search, number).toString(),
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: HCT_SEARCH } });
      return parseHct(await read(hctResultUrl(answer), { method: 'GET', headers }), number);
    };
    // An attempt that fails to reach HCT, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest. An HTTP status,
    // a rate limit included, is never sent again.
    return runSteps({ carrier: 'hct-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HctTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hct-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHctNumber(number))),
  };
};
