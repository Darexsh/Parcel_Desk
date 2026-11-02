import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CONNECT_COURIERS_MAX_BYTES, normalizeConnectCouriersNumber, parseConnectCouriers, PROVIDER } from './parser.js';

/** The WordPress endpoint the tracking page on connectcouriers.eu posts the number to. */
export const CONNECT_COURIERS_API = 'https://www.connectcouriers.eu/wp-admin/admin-ajax.php';
/** The tracking plugin's action. */
export const CONNECT_COURIERS_ACTION = 'public_connect_tracking_tracking_action';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the site, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*Just a moment|<title>\s*Attention Required/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Connect Couriers answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Connect Couriers returned a reply that is not JSON', { cause });
  }
}

export class ConnectCouriersTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeConnectCouriersNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(CONNECT_COURIERS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ action: CONNECT_COURIERS_ACTION, tracking_number: number }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CONNECT_COURIERS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Connect Couriers redirected its tracking lookup');
      // The tracker answers every number with HTTP 200. WordPress answers an
      // action no plugin registers with HTTP 400 and `0`; a 404 is a moved route.
      if (response.status === 400 || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Connect Couriers tracking lookup is unavailable');
      }
      return parseConnectCouriers(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'connect-couriers', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ConnectCouriersTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'connect-couriers', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeConnectCouriersNumber(number))),
  };
};
