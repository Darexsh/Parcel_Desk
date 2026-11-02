import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { normalizeUrbanoNumber, parseUrbano, PROVIDER, URBANO_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on urbano.com.pe makes for the numbers typed in. */
export const URBANO_API = 'https://api.urbanoenvios.pe/api/v1/trackingGlobal';
const REDIRECTS = [301, 302, 303, 307, 308];
// Laravel's answer for a route it does not have, which it gives as HTTP 500.
const MISSING_ROUTE = /"message"\s*:\s*"The route [^"]* could not be found\./;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com/i;

/** The page's request: one number, looked up as a guía or tracking code rather than a seller's reference. */
export function urbanoLookupBody(number: string): string {
  return JSON.stringify({ guia_barra: number, flag_seller: 0 });
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Urbano answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Urbano returned a reply that is not JSON', { cause });
  }
}

export class UrbanoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUrbanoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(URBANO_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: urbanoLookupBody(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: URBANO_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 500] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Urbano redirected its tracking lookup');
      // The page reads a missing parcel from a 200 reply; a 404 or a missing route is a moved lookup.
      const body = decodeText(bytes);
      if (response.status === 404 || response.status === 410 || (response.status === 500 && MISSING_ROUTE.test(body.slice(0, 4_000)))) {
        throw new TransportError(PROVIDER, 'Urbano tracking lookup is unavailable');
      }
      if (response.status === 500) throw new UpstreamHttpError(PROVIDER, 500);
      return parseUrbano(json(body), number);
    };
    // A read that fails to reach Urbano, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'urbano', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UrbanoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'urbano', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
