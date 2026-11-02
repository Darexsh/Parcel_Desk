
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeYtoNumber, parseYto } from './parser.js';

// Current domestic website request builder, queryWaybillTrackList:
// https://www.yto.net.cn/ (Nuxt client). This endpoint accepts anonymous reads.
const ENDPOINT = 'https://www.yto.net.cn/ec/order/gwWaybillInfoList';
// The same site on YTO's other domain, served from YTO's own addresses rather than the CDN
// edges www.yto.net.cn rotates through every minute, some of which take no connection.
const MIRROR = 'https://www.ytoexpress.com/ec/order/gwWaybillInfoList';

export class YtoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeYtoNumber(raw);
    const read = async (endpoint: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      try {
        const { bytes } = await fetchBounded(endpoint, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', source: 'PC', 'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify([number]),
        }, { provider: 'YTO Express', timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseYto(parseJsonBytes(bytes, 'YTO Express'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('YTO Express', 'YTO tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    };
    // A read that fails to reach the site, or hangs, gets one more try on the other domain,
    // as the first one's edge stays in the resolver's cache: the first gets half of the
    // budget, so the retry fits in the rest.
    return runSteps({ carrier: 'yto', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(ENDPOINT, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(MIRROR, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YtoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yto', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
