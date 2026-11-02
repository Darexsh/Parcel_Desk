import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRedxNumber, parseRedx, PROVIDER, REDX_MAX_BYTES } from './parser.js';

/** The lookup the public tracking page on redx.com.bd makes for the ID in its address. */
export const REDX_API = 'https://api.redx.com.bd/v1/logistics/global-tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the service, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
// The service's answer for a route that needs a signed-in merchant.
const NO_TOKEN = /"message"\s*:\s*"No token found!?"/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'RedX answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'RedX returned a reply that is not JSON', { cause });
  }
}

export class RedxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRedxNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${REDX_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: REDX_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'RedX redirected its tracking lookup');
      // The service reads an unknown ID from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'RedX tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 403) {
        // Merchant routes refuse a visitor with their own JSON; Cloudflare refuses some clients with a page.
        if (NO_TOKEN.test(body.slice(0, 4_000))) throw new TransportError(PROVIDER, 'RedX tracking lookup asks for a signed-in merchant');
        throw new ChallengeError(PROVIDER, 'RedX refused the lookup', { status: 403 });
      }
      return parseRedx(json(body), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'redx', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RedxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'redx', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRedxNumber(number))),
  };
};
