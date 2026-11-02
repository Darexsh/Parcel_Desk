import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRivigoNumber, parseRivigo, PROVIDER, RIVIGO_MAX_BYTES } from './parser.js';

/** Zoom's consignment lookup, which the public tracking page makes without a sign-in. */
export const RIVIGO_API = 'https://zoom-api.rivigo.com/tracking/v2/cnote/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request blocked)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one whole number. */
export function rivigoLookupUrl(number: string): string {
  return `${RIVIGO_API}${encodeURIComponent(normalizeRivigoNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Rivigo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Rivigo returned a reply that is not JSON', { cause });
  }
}

export class RivigoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page also sends its build in an `appVersion` header; an outdated one gets an empty HTTP 205, none gets the reply.
    const { response, bytes } = await fetchBounded(rivigoLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RIVIGO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // The lookup reads a missing consignment from a 200 reply; a redirect or a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Rivigo tracking lookup is unavailable', { status: response.status });
    }
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Rivigo refused the lookup', { status: 403 });
    if (response.status === 205) throw new SchemaError(PROVIDER, 'Rivigo asked for a newer tracking page', { status: 205 });
    return parseRivigo(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRivigoNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'rivigo', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RivigoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'rivigo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRivigoNumber(number))),
  };
};
