import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeedexNumber, parseSpeedex, PROVIDER, SPEEDEX_MAX_BYTES } from './parser.js';

/** The tracker page that Speedex's search result frames, for one number. */
export const SPEEDEX_TRACKER = 'https://www.speedex.gr/speedex/NewTrackAndTrace.aspx';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing parcel from a 200 reply; a 404 is a moved route.
const UNAVAILABLE = [404, 410];

export function speedexTrackerUrl(number: string): string {
  return `${SPEEDEX_TRACKER}?number=${encodeURIComponent(number)}`;
}

export class SpeedexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpeedexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(speedexTrackerUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SPEEDEX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Speedex redirected its tracking page');
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Speedex tracking page is unavailable');
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Speedex did not answer with its tracking page');
      return parseSpeedex(decodeText(bytes), number);
    };
    // A read that fails to reach Speedex, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'speedex', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: speedexTrackerUrl(number), maxBytes: SPEEDEX_MAX_BYTES,
        parse: html => parseSpeedex(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpeedexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new SpeedexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'speedex', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeSpeedexNumber(number))),
  };
};
