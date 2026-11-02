import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DAI_POST_MAX_BYTES, normalizeDaiPostNumber, parseDaiPost, PROVIDER } from './parser.js';

export const DAI_POST_TRACK_URL = 'https://daipost.com/track';

export class DaiPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDaiPostNumber(raw);
    return runSteps({ carrier: 'dai-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    let fetched: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      // `RSC: 1` asks the tracking page for its server components instead of HTML.
      fetched = await fetchBounded(`${DAI_POST_TRACK_URL}?tracknbr=${encodeURIComponent(number)}`, { signal, headers: {
        RSC: '1', Accept: 'text/x-component', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(budgetMs)), maxBytes: DAI_POST_MAX_BYTES, fetcher: this.options.fetcher });
    } catch (error) {
      // An unknown number is a 200 page naming it; a 404 means the page itself is gone.
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'DAI Post tracking page is unavailable', { status: error.status });
      }
      throw error;
    }
    return parseDaiPost(fetched.bytes, fetched.response.headers.get('content-type'), number);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DaiPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dai-post', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDaiPostNumber(number))) };
};
