import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { CARRIER, HITCH_MAX_BYTES, normalizeHitchNumber, parseHitch, PROVIDER } from './parser.js';

/** The tracker's page, which its search form opens with the number. */
export const HITCH_TRACKING = 'https://hitch.com.ph/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one number. */
export function hitchTrackingUrl(number: string): string {
  return `${HITCH_TRACKING}?${new URLSearchParams({ no: number })}`;
}

export class HitchTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(hitchTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HITCH_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The page answers HTTP 200 for a number it holds no booking under; a redirect or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Hitch tracking page moved', { status: response.status });
    return parseHitch(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHitchNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : DEFAULT_BUDGET_MS), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: hitchTrackingUrl(number), maxBytes: HITCH_MAX_BYTES,
        parse: html => parseHitch(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HitchTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new HitchTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeHitchNumber(number))),
  };
};
