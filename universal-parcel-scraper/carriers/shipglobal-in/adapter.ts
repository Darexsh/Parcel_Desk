import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeShipGlobalNumber, parseShipGlobal, PROVIDER, SHIPGLOBAL_MAX_BYTES } from './parser.js';

/** The anonymous request built by the script on shipglobal.in/tracking/. */
export const SHIPGLOBAL_API = 'https://tracking.shipglobal.in/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export function shipGlobalLookupUrl(raw: string): string {
  return `${SHIPGLOBAL_API}?${new URLSearchParams({ trackingId: normalizeShipGlobalNumber(raw) })}`;
}

/** Transport diagnostics can contain the private request or an entire shipment reply. */
function privateFailure(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  // Keep the network-failure class for the retry without retaining the client's URL or response.
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, new Error('ShipGlobal tracking request failed'));
  return error;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ShipGlobal answered with a browser check');
    // A JSON parse error can quote the response, including names and capability links.
    throw new SchemaError(PROVIDER, 'ShipGlobal returned a reply that is not JSON');
  }
}

export class ShipGlobalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShipGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let response: Response;
      let bytes: Uint8Array;
      try {
        ({ response, bytes } = await fetchBounded(shipGlobalLookupUrl(number), { method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
          maxBytes: SHIPGLOBAL_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] }));
      } catch (error) {
        throw privateFailure(error);
      }
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ShipGlobal redirected its tracking lookup');
      // Unknown numbers have a JSON notice on HTTP 200; a missing route says nothing about the parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'ShipGlobal tracking lookup is unavailable');
      return parseShipGlobal(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'shipglobal-in', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShipGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shipglobal-in', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeShipGlobalNumber(number))),
  };
};
