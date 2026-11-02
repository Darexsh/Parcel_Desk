import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { MALTAPOST_MAX_BYTES, normalizeMaltaPostNumber, parseMaltaPost, PROVIDER } from './parser.js';

// The service www.maltapost.com/tracking reads for one barcode.
export const MALTAPOST_ENDPOINT = 'https://www.maltapost.com/TrackAndTraceApi/v1/trackedItems';
// A web application firewall or CDN block page.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|The requested URL was rejected|Incapsula incident|cf-chl-|cf-turnstile/i;

export class MaltaPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMaltaPostNumber(raw);
    const url = `${MALTAPOST_ENDPOINT}?${new URLSearchParams({ barcode: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
          { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MALTAPOST_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // A missing route is not a missing item: the service answers unknown barcodes with an empty item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'MaltaPost tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'MaltaPost answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'MaltaPost returned invalid tracking JSON', { cause });
      }
      return parseMaltaPost(payload, number);
    };
    // A request that fails to reach MaltaPost, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'maltapost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MaltaPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'maltapost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMaltaPostNumber(number))),
  };
};
