import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import {
  GEBRUEDER_WEISS_MAX_BYTES, normalizeGebruederWeissNumber, normalizeGebruederWeissPostcode, parseGebruederWeiss, PROVIDER,
} from './parser.js';

// The public search the Track & Trace page on my.gw-world.com posts, without a key, cookie or CAPTCHA.
export const GEBRUEDER_WEISS_ENDPOINT = 'https://my.gw-world.com/api/ptnt/public/orders';
const ORIGIN = 'https://my.gw-world.com';
// The firewall's rejection page, which it serves with HTTP 200 under the portal's maintenance title.
const REJECTED = /The requested URL was rejected|<title>\s*(?:Access denied|403 Forbidden|Request Rejected)/i;

/** The search's address for a number and the sender's or recipient's postcode: the first page of twenty, as the page asks. */
export function gebruederWeissSearchUrl(raw: string, rawPostcode: string): string {
  return `${GEBRUEDER_WEISS_ENDPOINT}?${new URLSearchParams({
    orderReferenceQuery: normalizeGebruederWeissNumber(raw),
    shipperConsigneeAddressQuery: normalizeGebruederWeissPostcode(rawPostcode),
    offset: '0',
    pageSize: '20',
  })}`;
}

/** The same failure without the request and response details fetchBounded attaches: the address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class GebruederWeissTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGebruederWeissNumber(raw);
    // Without the postcode the search answers nothing, so no request is made.
    const url = gebruederWeissSearchUrl(number, normalizeGebruederWeissPostcode(rawPostcode));
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
          Accept: 'application/json, text/plain, */*', Origin: ORIGIN, Referer: `${ORIGIN}/trackntrace/-/search/`,
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GEBRUEDER_WEISS_MAX_BYTES,
          fetcher: this.options.fetcher }));
      } catch (error) {
        // A missing route is not a missing shipment.
        if (error instanceof UpstreamHttpError && [404, 405, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Gebrüder Weiss tracking service is unavailable');
        }
        throw withoutPostcode(error);
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch {
        if (REJECTED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Gebrüder Weiss rejected the request');
        throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned invalid tracking JSON');
      }
      return parseGebruederWeiss(payload, number);
    };
    // A request that fails to reach Gebrüder Weiss, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gebrueder-weiss', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GebruederWeissTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Every lookup needs the postcode, and an unknown number and a wrong postcode
  // look alike, so the adapter cannot recognize a number alone.
  return {
    id: 'gebrueder-weiss', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
