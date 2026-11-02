import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GIG_LOGISTICS_MAX_BYTES, normalizeGigLogisticsNumber, parseGigLogistics, PROVIDER } from './parser.js';

/** The tracking page, which asks the lookup for the waybill in its query. */
export const GIG_LOGISTICS_PAGE = 'https://giglogistics.com/track-shipment/';
/** The lookup the tracking page asks, followed by the waybill. */
export const GIG_LOGISTICS_API = 'https://agility.giglogistics.com/api/portal/trackshipment/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or a firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details|captcha/i;

/** The reply's JSON. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GIG Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GIG Logistics returned a reply that is not JSON', { cause });
  }
}

export class GigLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGigLogisticsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${GIG_LOGISTICS_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', Referer: GIG_LOGISTICS_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GIG_LOGISTICS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The lookup answers every waybill, known or not, with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'GIG Logistics tracking lookup moved', { status: response.status });
      return parseGigLogistics(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'gig-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GigLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gig-logistics', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
