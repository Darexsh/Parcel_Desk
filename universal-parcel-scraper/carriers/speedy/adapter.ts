import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeedyNumber, parseSpeedyReply, PROVIDER, SPEEDY_MAX_BYTES } from './parser.js';

// The endpoint MySpeedy's public tracker and the Speedy app read a shipment
// from. www.speedy.bg sits behind a Cloudflare challenge; this host does not.
export const SPEEDY_ENDPOINT = 'https://myspeedy.speedy.bg/rest/public/track';

export class SpeedyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeSpeedyNumber(raw);
    return runSteps({ carrier: 'speedy', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${SPEEDY_ENDPOINT}?${new URLSearchParams({ id: number, language: 'en' })}`, { signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: SPEEDY_MAX_BYTES,
        allowHttpStatuses: [404], fetcher: this.options.fetcher,
      });
      return parseSpeedyReply(response.status, decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SpeedyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'speedy', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpeedyNumber(number))) };
};
