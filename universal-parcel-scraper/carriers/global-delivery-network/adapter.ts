import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GDN_MAX_BYTES, gdnUrl, normalizeGdnNumber, parseGdn, PROVIDER } from './parser.js';

export class GdnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeGdnNumber(raw);
    return runSteps({ carrier: 'global-delivery-network', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let bytes: Uint8Array;
      try { ({ bytes } = await fetchBounded(gdnUrl(number), {
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) }, signal,
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: GDN_MAX_BYTES, fetcher: this.options.fetcher })); }
      catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError(PROVIDER, 'Global Delivery Network tracking page is unavailable', { cause: error });
        throw error;
      }
      return parseGdn(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GdnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'global-delivery-network', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
