import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { userAgentOf } from '../../core/transport/index.js';
import { askMailTracing } from './chatbot.js';
import { normalizeHongkongPostNumber, parseHongkongPostAnswer } from './parser.js';

/** Ten short requests normally take a few seconds; an idle poll alone holds 30 s. */
const DEFAULT_BUDGET_MS = 25_000;

export class HongkongPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHongkongPostNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    return runSteps({ carrier: 'hongkong-post', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const answer = await askMailTracing(number, { fetcher: this.options.fetcher, userAgent, signal, deadline, budgetMs,
        // The step's signal ends at the budget too, and its timer can fire just before the deadline reads as passed.
        spent: () => performance.now() >= deadline || (signal.aborted && !context.signal?.aborted) });
      return parseHongkongPostAnswer(answer);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HongkongPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'hongkong-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
