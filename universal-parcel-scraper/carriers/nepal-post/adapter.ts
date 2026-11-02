import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { nepalPostNumber, parseNepalPost, PROVIDER } from './parser.js';

export const NEPAL_POST_ENDPOINT = 'https://pits.gpo.gov.np/Inquiry/InquiryIndexClient';

export class NepalPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = nepalPostNumber(raw);
    return runSteps({ carrier: 'nepal-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${NEPAL_POST_ENDPOINT}?${new URLSearchParams({ ItemId: number })}`, {
        method: 'GET', signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: remainingMs, fetcher: this.options.fetcher, maxBytes: 512 * 1024, allowHttpStatuses: [404, 410] });
      if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Nepal Post tracking endpoint is unavailable');
      return parseNepalPost(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new NepalPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'nepal-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => nepalPostNumber(number))) };
};
