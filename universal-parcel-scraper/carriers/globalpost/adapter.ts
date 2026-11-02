import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GLOBALPOST_MAX_BYTES, normalizeGlobalpostNumber, parseGlobalpost, PROVIDER, readGlobalpostRedirect } from './parser.js';

/** The page the tracking form on goglobalpost.com opens for the number typed in. */
export const GLOBALPOST_TRACK_DETAIL = 'https://www.goglobalpost.com/track-detail/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page sends an unknown number on with a redirect: a missing route is not a missing parcel.
const GONE = [404, 410];

export class GlobalpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGlobalpostNumber(raw);
    const url = `${GLOBALPOST_TRACK_DETAIL}?t=${number}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GLOBALPOST_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) return readGlobalpostRedirect(response.headers.get('location'), number);
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The GlobalPost tracking page moved', { status: response.status });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'GlobalPost returned an empty page');
      return parseGlobalpost(html, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'globalpost', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: GLOBALPOST_MAX_BYTES,
        parseRedirect: (redirected, html) => readGlobalpostRedirect(redirected, number, html), parse: html => parseGlobalpost(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GlobalpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: 'globalpost', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
