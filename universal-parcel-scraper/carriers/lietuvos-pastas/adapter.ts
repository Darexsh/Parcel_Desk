import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { LIETUVOS_PASTAS_MAX_BYTES, normalizeLietuvosPastasNumber, parseLietuvosPastas, PROVIDER } from './parser.js';

// The self-service API behind LP Express's tracking page, which answers
// without a key, cookie or token. Its second version groups the rows by mail
// and tells an unknown number from a known one without rows.
export const LIETUVOS_PASTAS_ENDPOINT = 'https://api-esavitarna.post.lt/v2/tracking';
// The F5 firewall in front of the API rejects some clients with an HTML page.
const BLOCKED = /Request Rejected|The requested URL was rejected|support ID|TSPD/i;

export function lietuvosPastasUrl(number: string): string {
  return `${LIETUVOS_PASTAS_ENDPOINT}/${encodeURIComponent(number)}/events`;
}

export class LietuvosPastasTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLietuvosPastasNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        // The language header picks the wording, Lithuanian by default.
        ({ bytes } = await fetchBounded(lietuvosPastasUrl(number), { signal,
          headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LIETUVOS_PASTAS_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number has its own answer; a missing route is not a missing parcel.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Lietuvos paštas tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Lietuvos paštas answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Lietuvos paštas returned invalid tracking JSON', { cause });
      }
      return parseLietuvosPastas(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'lietuvos-pastas', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LietuvosPastasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'lietuvos-pastas', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLietuvosPastasNumber(number))),
  };
};
