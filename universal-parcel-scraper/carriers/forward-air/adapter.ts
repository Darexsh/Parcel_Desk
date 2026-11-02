import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FORWARD_AIR_MAX_BYTES, normalizeForwardAirNumber, parseForwardAir, PROVIDER } from './parser.js';

/** The lookup the tracking page on www.forwardair.com makes for the waybills in its address. */
export const FORWARD_AIR_API = 'https://api-prod.forwardair.com/tracking/shipments';
const SITE = 'https://www.forwardair.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service's refusal of a request that does not name the site as its referrer.
const REFUSED = 418;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|AwsWafIntegration|awswaf\.com/i;

/** The lookup's address for one waybill. */
export function forwardAirLookupUrl(number: string): string {
  return `${FORWARD_AIR_API}?numbers=${encodeURIComponent(normalizeForwardAirNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Forward Air answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Forward Air returned a reply that is not JSON', { cause });
  }
}

export class ForwardAirTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeForwardAirNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request: a cross-origin read naming the site, which the service requires.
      const { response, bytes } = await fetchBounded(forwardAirLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FORWARD_AIR_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, REFUSED] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Forward Air redirected its tracking lookup');
      // The page reads an unknown waybill from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Forward Air tracking lookup is unavailable');
      if (response.status === REFUSED) throw new ChallengeError(PROVIDER, 'Forward Air refused the lookup', { status: REFUSED });
      return parseForwardAir(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'forward-air', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ForwardAirTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'forward-air', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeForwardAirNumber(number))),
  };
};
