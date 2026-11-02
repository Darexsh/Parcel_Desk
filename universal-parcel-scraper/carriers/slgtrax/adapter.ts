import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSlgtraxNumber, parseSlgtrax, PROVIDER, SLGTRAX_MAX_BYTES, slgtraxJson } from './parser.js';

/** The lookup slgtrax.com's tracking box makes for the number typed in. */
export const SLGTRAX_API = 'https://sonic.pk/api/shipment/track/consignee/public';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class SlgtraxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${SLGTRAX_API}?${new URLSearchParams({ tracking_number: number }).toString()}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
      headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SLGTRAX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The lookup answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SLGTrax redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'SLGTrax tracking lookup is unavailable', { status: response.status });
    return parseSlgtrax(slgtraxJson(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSlgtraxNumber(raw);
    // sonic.pk drops connections from some networks: a read that fails to
    // reach it, or hangs, is sent once more, and the first try gets half of
    // the budget.
    return runSteps({ carrier: 'slgtrax', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SlgtraxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'slgtrax', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSlgtraxNumber(number))),
  };
};
