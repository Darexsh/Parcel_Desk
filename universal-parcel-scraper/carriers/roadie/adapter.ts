import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseRoadie, roadieNumber } from './parser.js';

export class RoadieTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = roadieNumber(raw);
    return runSteps({ carrier: 'roadie', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`https://api.roadie.com/gigs/${number}/track`, {
        signal, headers: { Accept: 'application/json;version=3', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: 'Roadie', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        fetcher: this.options.fetcher, allowHttpStatuses: [403, 404] });
      if (response.status === 403) throw new ChallengeError('Roadie', 'Roadie requires US network access');
      if (response.status === 404) {
        if (bytes.length === 0) throw new NotFoundError('Roadie');
        throw new TransportError('Roadie', 'Roadie tracking endpoint is unavailable');
      }
      return parseRoadie(parseJsonBytes(bytes, 'Roadie'), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RoadieTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'roadie', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => roadieNumber(number))) };
};
