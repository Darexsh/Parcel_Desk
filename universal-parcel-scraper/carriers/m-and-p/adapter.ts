import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { M_AND_P_MAX_BYTES, normalizeMAndPNumber, parseMAndP, PROVIDER } from './parser.js';

/** The tracker's page, which the server renders for the consignment number that ends its path. */
export const M_AND_P_TRACKING = 'https://www.mulphilog.com/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class MAndPTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${M_AND_P_TRACKING}${number}`, { method: 'GET', signal,
      headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: M_AND_P_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The tracker answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'M&P redirected its tracker', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'M&P tracker is unavailable', { status: response.status });
    return parseMAndP(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMAndPNumber(raw);
    // A read that fails to reach M&P, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: 'm-and-p', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : DEFAULT_BUDGET_MS), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: `${M_AND_P_TRACKING}${number}`, maxBytes: M_AND_P_MAX_BYTES,
        parse: html => parseMAndP(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MAndPTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new MAndPTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'm-and-p', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeMAndPNumber(number))),
  };
};
