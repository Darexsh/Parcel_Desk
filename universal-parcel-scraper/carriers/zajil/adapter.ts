import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isZajilNotFound, normalizeZajilNumber, parseZajil, PROVIDER, ZAJIL_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on zajil-express.com makes for a shipment, followed by the number. */
export const ZAJIL_API = 'https://mobileapi.zajil-express.org/track?shipment=';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class ZajilTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZajilNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${ZAJIL_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZAJIL_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 500] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Zajil redirected its tracking lookup');
      const body = decodeText(bytes);
      const payload = json(body);
      // The page shows "No Shipment Found" for any failed lookup. The lookup's
      // own error for an unknown number is HTTP 404 with `shipment_not_found`;
      // any other 404 is a moved route.
      if (response.status === 404 || response.status === 410) {
        if (response.status === 404 && isZajilNotFound(payload)) return parseZajil(payload, number);
        throw new TransportError(PROVIDER, 'Zajil tracking lookup is unavailable', { status: response.status });
      }
      // Its server error, which it also answers for every eleven-digit number it
      // has no shipment for, proves no absence.
      if (response.status === 500) {
        throw new IndeterminateError(PROVIDER, 'Zajil has no shipment for this number or failed to look it up', { reason: 'portal_not_found', status: 500 });
      }
      if (payload === undefined) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Zajil answered with a browser check');
        throw new SchemaError(PROVIDER, 'Zajil returned a reply that is not JSON');
      }
      return parseZajil(payload, number);
    };
    // One read with the whole budget: a number the lookup cannot answer holds
    // the request open until it fails, and a second request would only add
    // another.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZajilTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
