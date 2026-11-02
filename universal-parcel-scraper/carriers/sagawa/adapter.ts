import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readSagawaWidget } from './app.js';
import { normalizeSagawaNumber } from './parser.js';

export class SagawaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSagawaNumber(raw);
    return runSteps({ carrier: 'sagawa', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'app', run: ({ signal, remainingMs }) => readSagawaWidget(number, {
      fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, timeoutMs: Math.max(1, Math.floor(remainingMs)),
    }) }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SagawaTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'sagawa', recordsSteps: true, steps: ['app'], track: (input, context) => tracker.fetch(input.number, context) };
};
