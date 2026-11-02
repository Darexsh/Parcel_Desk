import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeRelaytechNumber, normalizeRelaytechPostcode, parseRelaytech, PROVIDER, RELAYTECH_MAX_BYTES,
} from './parser.js';

/** The lookup Relay's tracking app at track.relaytech.co makes, without a key, cookie or CAPTCHA. */
export const RELAYTECH_API = 'https://relay-production.relaytechapis.co/v0/customer-portal/shipments';
const ORIGIN = 'https://track.relaytech.co';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker's answer for an unknown tracking ID and for a missing or wrong postcode alike.
const NO_ORDER = /^No order was found for that tracking number\.?$/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|<title>\s*(?:Access denied|Attention Required|403 Forbidden)/i;
const HTML = /^\s*<(?:!doctype|html|head|body)\b/i;

/** The tracker's address for a tracking ID and its postcode, as the app builds it. */
export function relaytechShipmentUrl(raw: string, rawPostcode: string | null | undefined): string {
  return `${RELAYTECH_API}/${normalizeRelaytechNumber(raw)}?postcode=${encodeURIComponent(normalizeRelaytechPostcode(rawPostcode))}`;
}

/** The same failure without the request and response details fetchBounded attaches: the address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    if (HTML.test(body) || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Relay answered with a web page instead of the shipment');
    throw new SchemaError(PROVIDER, 'Relay returned a reply that is not JSON');
  }
}

/**
 * A 404. The tracker's own one is JSON with a `detail`. It says the same for
 * an unknown ID and for a wrong postcode, so it does not show the parcel is
 * missing. FastAPI's bare "Not Found" and the gateway's plain text are a
 * missing route.
 */
function notFound(body: string): never {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Relay answered with a web page instead of the shipment');
    throw new TransportError(PROVIDER, 'Relay tracking service is unavailable');
  }
  if (typeof detail === 'string' && NO_ORDER.test(detail.trim())) {
    throw new IndeterminateError(PROVIDER, 'Relay has no order for that tracking ID and postcode', { reason: 'portal_not_found' });
  }
  if (detail === 'Not Found') throw new TransportError(PROVIDER, 'Relay tracking service is unavailable');
  throw new SchemaError(PROVIDER, 'Relay answered with an unknown 404');
}

export class RelaytechTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRelaytechNumber(raw);
    // Without the postcode the tracker opens nothing, so no request is made.
    const url = relaytechShipmentUrl(number, rawPostcode);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let response: Response;
      let bytes: Uint8Array;
      try {
        ({ response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RELAYTECH_MAX_BYTES, redirect: 'manual',
          fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404] }));
      } catch (error) {
        throw withoutPostcode(error);
      }
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Relay redirected its tracking lookup');
      const body = decodeText(bytes);
      if (response.status === 404) notFound(body);
      return parseRelaytech(json(body), number);
    };
    return runSteps({ carrier: 'relaytech', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RelaytechTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Every lookup needs the postcode, and an unknown ID and a wrong postcode
  // look alike, so the adapter cannot recognize a number alone.
  return {
    id: 'relaytech', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
