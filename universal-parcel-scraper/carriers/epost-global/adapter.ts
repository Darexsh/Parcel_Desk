import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EPOST_GLOBAL_MAX_BYTES, normalizeEpostGlobalNumber, parseEpostGlobal, PROVIDER } from './parser.js';

/** The action the tracking page posts its numbers to. */
export const EPOST_GLOBAL_ENDPOINT = 'https://epgtrack.com/TrackingShipment/ShipmentData';

export class EpostGlobalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEpostGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { bytes } = await fetchBounded(EPOST_GLOBAL_ENDPOINT, { method: 'POST', signal, headers: {
        Accept: 'text/html, */*; q=0.01', 'User-Agent': userAgentOf(this.options.userAgent), 'X-Requested-With': 'XMLHttpRequest',
      }, body: new URLSearchParams({ id: number }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EPOST_GLOBAL_MAX_BYTES, fetcher: this.options.fetcher });
      return parseEpostGlobal(decodeText(bytes), raw);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'epost-global', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EpostGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'epost-global', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEpostGlobalNumber(number))),
  };
};
