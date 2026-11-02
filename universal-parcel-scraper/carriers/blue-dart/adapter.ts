import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeBlueDartNumber, parseBlueDart } from './parser.js';

const ENDPOINT = 'https://www.bluedart.com/trackdartresultthirdparty';

export class BlueDartTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBlueDartNumber(raw);
    return runSteps({ carrier: 'blue-dart', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let bytes: Uint8Array;
      try { ({ bytes } = await fetchBounded(`${ENDPOINT}?trackFor=0&trackNo=${number}`, {
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) }, signal,
      }, { provider: 'Blue Dart', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher })); }
      catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Blue Dart', 'Blue Dart tracking endpoint is unavailable', { cause: error });
        throw error;
      }
      return parseBlueDart(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BlueDartTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'blue-dart', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBlueDartNumber(number))),
  };
};
