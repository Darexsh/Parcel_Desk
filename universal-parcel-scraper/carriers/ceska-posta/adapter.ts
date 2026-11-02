import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { CESKA_POSTA_MAX_BYTES, normalizeCeskaPostaNumber, parseCeskaPosta, PROVIDER } from './parser.js';

// Česká pošta's public B2C tracking service, which it documents for anyone to
// call: no key, cookie or token. The tracking page shows the same rows.
export const CESKA_POSTA_ENDPOINT = 'https://b2c.cpost.cz/services/ParcelHistory/getDataAsJson';
// The F5 firewall in front of the service rejects a request with an HTML page.
const BLOCKED = /Request Rejected|The requested URL was rejected|support ID|TSPD/i;

export function ceskaPostaUrl(number: string): string {
  return `${CESKA_POSTA_ENDPOINT}?idParcel=${encodeURIComponent(number)}&language=en`;
}

export class CeskaPostaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCeskaPostaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        // The language parameter picks the wording; the header is pinned so a
        // client's default cannot change it.
        ({ bytes } = await fetchBounded(ceskaPostaUrl(number), { signal,
          headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CESKA_POSTA_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number has its own notice; a missing route is not a missing item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Česká pošta tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Česká pošta answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Česká pošta returned invalid tracking JSON', { cause });
      }
      return parseCeskaPosta(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ceska-posta', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CeskaPostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ceska-posta', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCeskaPostaNumber(number))),
  };
};
