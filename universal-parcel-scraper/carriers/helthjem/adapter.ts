import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { HELTHJEM_MAX_BYTES, normalizeHelthjemNumber, parseHelthjem, PROVIDER } from './parser.js';

// The GraphQL service helthjem.no/sporing asks, without a key, cookie or token.
export const HELTHJEM_ENDPOINT = 'https://services.helthjem.no/graphql';
// The fields the adapter reads: no addresses, postcodes, phone numbers or coordinates.
export const HELTHJEM_QUERY = `query GetTracking($parcelReference: String!) {
  getParcelTrackingDetails(parcelReference: $parcelReference) {
    parcelReference
    trackingNumber
    shipmentNumber
    status
    isPostnordProduct
    events { apiKey status createdAt location message { content } }
    servicePoint { name }
    shop { name }
  }
}`;
// A CloudFront or Cloudflare block page instead of the service's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|ERROR: The request could not be satisfied)|Request blocked|cf-chl-|cf-turnstile/i;

export class HelthjemTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { reference } = normalizeHelthjemNumber(raw);
    const body = JSON.stringify({ operationName: 'GetTracking', variables: { parcelReference: reference }, query: HELTHJEM_QUERY });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        // A query the service rejects comes back as HTTP 400 with GraphQL errors.
        ({ bytes } = await fetchBounded(HELTHJEM_ENDPOINT, { method: 'POST', body, signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HELTHJEM_MAX_BYTES, fetcher: this.options.fetcher,
          allowHttpStatuses: [400] }));
      } catch (error) {
        // An unknown number is a null parcel; a missing route is not a missing parcel.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Helthjem tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Helthjem answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Helthjem returned invalid tracking JSON', { cause });
      }
      return parseHelthjem(payload, reference);
    };
    // A request that fails to reach Helthjem, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'helthjem', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HelthjemTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'helthjem', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHelthjemNumber(number))),
  };
};
