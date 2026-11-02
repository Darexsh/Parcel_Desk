import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ESTES_FORWARDING_MAX_BYTES, normalizeEstesForwardingNumber, parseEstesForwarding, PROVIDER } from './parser.js';

/** The lookup the tracking page at efwtrack.com/track/{number} makes. */
export const ESTES_FORWARDING_API = 'https://efwtrack.com/api/ShipmentTracking/get_shipment_tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|_Incapsula_Resource|captcha/i;

/** The form the page posts: the number, and `NONE` where a ZIP code would go. */
export function estesForwardingLookupBody(number: string): string {
  return new URLSearchParams({ TrackNo: normalizeEstesForwardingNumber(number), ConZip: 'NONE' }).toString();
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'EFW answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'EFW returned a reply that is not JSON', { cause });
  }
}

export class EstesForwardingTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEstesForwardingNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(ESTES_FORWARDING_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: estesForwardingLookupBody(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: ESTES_FORWARDING_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'EFW redirected its tracking lookup');
      if (response.status === 410) throw new TransportError(PROVIDER, 'EFW tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 404) {
        // An unknown number is a 404 with the service's own message; another 404 is a moved route.
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
        if (!isRecord(payload) || !isRecord(payload.metadata)) throw new TransportError(PROVIDER, 'EFW tracking lookup is unavailable');
        return parseEstesForwarding(payload, number);
      }
      return parseEstesForwarding(json(body), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'estes-forwarding', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EstesForwardingTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'estes-forwarding', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEstesForwardingNumber(number))),
  };
};
