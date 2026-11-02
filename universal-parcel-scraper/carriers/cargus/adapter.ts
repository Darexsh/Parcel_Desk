import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readCargusApp } from './app.js';
import { normalizeCargusNumber } from './parser.js';

/** The key the Cargus app ships to every install. */
const KEY = '5F66C878478EBCB2F3967DF94BE57959'; // gitleaks:allow

export class CargusTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCargusNumber(raw);
    return runSteps({ carrier: 'cargus', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{
      id: 'direct', run: ({ signal, remainingMs }) => readCargusApp(number, {
        key: KEY, fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, timeoutMs: remainingMs,
      }),
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CargusTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'cargus', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCargusNumber(number))) };
};
