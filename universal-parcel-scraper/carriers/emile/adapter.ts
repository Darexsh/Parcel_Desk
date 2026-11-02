import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EMILE_MAX_BYTES, normalizeEmileNumber, parseEmileTrackingXml } from './parser.js';

const ENDPOINT = 'https://www.emileps.com/emile/track';

export class EmileTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeEmileNumber(raw);
    return runSteps({ carrier: 'emile', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal,
          headers: { Accept: 'application/xml', 'Content-Type': 'application/xml', 'User-Agent': userAgentOf(this.options.userAgent) },
          body: `<tracks><language>en</language><track><barcode>${number}</barcode></track></tracks>` }, {
          provider: 'Emile', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: EMILE_MAX_BYTES, fetcher: this.options.fetcher,
        });
        return parseEmileTrackingXml(decodeText(bytes), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('Emile', 'Emile tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EmileTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'emile', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEmileNumber(number))) };
};
