import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeedxNumber, parseSpeedx } from './parser.js';

const PAGE = 'https://tracking.speedx.io/';

export class SpeedxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpeedxNumber(raw);
    return runSteps({ carrier: 'speedx', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let fetched: Awaited<ReturnType<typeof fetchBounded>>;
      try {
        // `RSC: 1` asks the tracking page for its server components instead of HTML.
        fetched = await fetchBounded(`${PAGE}${number}`, { signal, headers: {
          RSC: '1', Accept: 'text/x-component', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: 'SpeedX', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
      } catch (error) {
        // An unknown number is a 200 page naming it; a 404 means the page itself is gone.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('SpeedX', 'SpeedX tracking page is unavailable', { cause: error });
        }
        throw error;
      }
      const contentType = fetched.response.headers.get('content-type');
      return parseSpeedx(decodeText(fetched.bytes, 'utf-8'), contentType, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SpeedxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'speedx', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
