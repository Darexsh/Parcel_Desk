import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeYypostNumber, parseYypost, PROVIDER, YYPOST_MAX_BYTES } from './parser.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from './rtb56.js';

/** The tracking page, which opens the parcel from its `c` parameter. */
export const YYPOST_PAGE = 'http://www.yypostal.com/track.html';
/** The lookup the page makes on YYpost's tenant of its tracking platform, which answers plain HTTP only. */
export const YYPOST_API = 'http://szyy.rtb56.com/webservice/Service.ashx';
/** The JSONP callback the adapter names, as the page's jQuery does. */
export const YYPOST_CALLBACK = 'yypostTrack';
/** The page's request for one number. */
export function yypostLookupUrl(number: string): string {
  return rtb56LookupUrl(YYPOST_API, YYPOST_CALLBACK, number);
}

export class YypostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeYypostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(yypostLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01', Referer: `${YYPOST_PAGE}?c=${number}`,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: YYPOST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // The lookup answers every number with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'YYpost tracking lookup moved', { status: response.status });
      return parseYypost(rtb56Json(decodeText(bytes), YYPOST_CALLBACK, PROVIDER), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'yypost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new YypostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yypost', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
