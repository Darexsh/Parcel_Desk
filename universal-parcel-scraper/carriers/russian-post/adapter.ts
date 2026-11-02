import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseRussianPost, PROVIDER, russianPostNumber } from './parser.js';

export const RUSSIAN_POST_ENDPOINT = 'https://www.pochta.ru/api/tracking/api/v1/trackings/detailed';

export class RussianPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = russianPostNumber(raw);
    return runSteps({ carrier: 'russian-post', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${RUSSIAN_POST_ENDPOINT}?${new URLSearchParams({ language: 'en', 'track-numbers': number })}`, {
        method: 'GET', signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs, maxBytes: 2_000_000, allowHttpStatuses: [404, 410, 417] });
      if (response.status === 417) throw new ChallengeError(PROVIDER, 'Russian Post requires Russian network access');
      if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Russian Post tracking endpoint is unavailable');
      if (/<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|_cf_chl_opt/i.test(decodeText(bytes).slice(0, 16_000))) {
        throw new ChallengeError(PROVIDER, 'Russian Post answered with a block page');
      }
      return parseRussianPost(parseJsonBytes(bytes, PROVIDER), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RussianPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'russian-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => russianPostNumber(number))) };
};
