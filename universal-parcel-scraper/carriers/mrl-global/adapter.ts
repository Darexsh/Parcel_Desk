import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { MRL_MAX_BYTES, MRL_TRACKING, normalizeMrlNumber, parseMrl, PROVIDER } from './parser.js';

export { MRL_TRACKING } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracking page's address for one consignment, as its search form opens it. */
export function mrlTrackingUrl(number: string): string {
  return `${MRL_TRACKING}?${new URLSearchParams({ connoteno: normalizeMrlNumber(number) }).toString()}`;
}

export class MrlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(mrlTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MRL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The page answers an unknown number with HTTP 200; a redirect or a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'MRL Global’s tracking page is unavailable', { status: response.status });
    }
    return parseMrl(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMrlNumber(raw);
    // A lookup that fails to reach MRL Global, or hangs, is asked once more:
    // the first try gets half of the budget. An HTTP status is never sent again.
    return runSteps({ carrier: 'mrl-global', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : DEFAULT_BUDGET_MS), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: mrlTrackingUrl(number), maxBytes: MRL_MAX_BYTES,
        parse: html => parseMrl(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MrlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: 'mrl-global', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
