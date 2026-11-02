import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeQuantiumNumber, parseQuantium, PROVIDER, QUANTIUM_MAX_BYTES } from './parser.js';

/** The lookup the tracker on track.quantiumworldwide.com makes, from the page it frames, for the number typed in. */
export const QUANTIUM_API = 'https://itapps.quantiumworldwide.com/itcms_tracking/api/itcommon/general_sql';
/** The stored query that page names for an order lookup. */
export const QUANTIUM_QUERY = 'itcms_sql\\d_order_track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)|AwsWafIntegration|awswaf\.com|incapsula|ddos-guard/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Quantium answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Quantium returned a reply that is not JSON', { cause });
  }
}

export class QuantiumTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeQuantiumNumber(raw);
    // The page sends the stored query's arguments as a JSON string inside the JSON body.
    const body = JSON.stringify({ query_name: QUANTIUM_QUERY, query_json: JSON.stringify({ cust_code: '', order_no: number }) });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(QUANTIUM_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: QUANTIUM_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Quantium redirected its tracking lookup');
      // The page reads a missing parcel from an empty list; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Quantium tracking lookup is unavailable');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Quantium refused the lookup', { status: 403 });
      return parseQuantium(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'quantium-solutions', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QuantiumTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'quantium-solutions', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeQuantiumNumber(number))),
  };
};
