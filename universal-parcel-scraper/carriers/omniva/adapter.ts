import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeOmnivaNumber, OMNIVA_MAX_BYTES, parseOmniva, PROVIDER } from './parser.js';

// The guest lookup of Omniva's app. The web trackers' own API wants a
// Turnstile token; this one answers without a key, cookie or token.
export const OMNIVA_ENDPOINT = 'https://mobile-be.omniva.ee/api/v2/shipment/trackSingleShipment/';
// A Cloudflare challenge, or the application gateway's own 403 page.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|403 Forbidden)|cf-chl-|challenge-platform|cf-turnstile|Application-Gateway/i;

export class OmnivaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOmnivaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(OMNIVA_ENDPOINT + encodeURIComponent(number), { signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OMNIVA_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number is an empty object; a missing route is not a missing item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Omniva tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Omniva answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Omniva returned invalid tracking JSON', { cause });
      }
      return parseOmniva(payload, number);
    };
    // A request that fails to reach Omniva, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'omniva', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OmnivaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'omniva', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeOmnivaNumber(number))),
  };
};
