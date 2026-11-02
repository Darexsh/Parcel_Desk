import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { indonesianJntNumber, normalizeJntNumber, readJnt } from './app.js';

const DEFAULT_BUDGET_MS = 15_000;

export class JntExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJntNumber(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('J&T budget must be positive');
    return runSteps({ carrier: 'j-and-t', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => readJnt(number, { fetcher: this.options.fetcher,
        userAgent: this.options.userAgent, signal, timeoutMs: Math.max(1, Math.floor(remainingMs)) }) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JntExpressTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'j-and-t', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // Only an Indonesian waybill can be missing from the router; other shapes stay unknown without a request.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => indonesianJntNumber(number))) };
};
