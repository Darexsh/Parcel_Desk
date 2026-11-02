import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePitneyBowesNumber, parsePitneyBowes, PITNEY_BOWES_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup the tracking page on trackpb.shipment.co makes for the number in its address. */
export const PITNEY_BOWES_API = 'https://trackpb.shipment.co/api/track/package-details/';
/**
 * The tracker's brand on its platform, which the page reads from its public
 * configuration (`published-configurations/trackpb`) and sends with every
 * lookup; it is the same for every visitor.
 */
export const PITNEY_BOWES_BRAND = 'RALVsUZS';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pitney Bowes answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Pitney Bowes returned a reply that is not JSON', { cause });
  }
}

export class PitneyBowesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePitneyBowesNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${PITNEY_BOWES_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'X-BRAND-ID': PITNEY_BOWES_BRAND, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PITNEY_BOWES_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Pitney Bowes redirected its tracking lookup');
      // The lookup answers every number with a 200; a 404 is a moved route or a brand the platform no longer knows.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Pitney Bowes tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 400) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pitney Bowes answered with a browser check', { status: 400 });
        // The platform refuses a lookup without its brand header this way.
        throw new SchemaError(PROVIDER, 'Pitney Bowes refused the lookup', { status: 400 });
      }
      return parsePitneyBowes(json(body), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pitney-bowes', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PitneyBowesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pitney-bowes', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
