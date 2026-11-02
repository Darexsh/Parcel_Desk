import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePostmediaNumber, normalizePostmediaPostcode, parsePostmedia, POSTMEDIA_MAX_BYTES, PROVIDER } from './parser.js';

/** The API the tracker on postmediaparcelservices.com asks for one number and postal code. */
export const POSTMEDIA_API = 'https://pmparcelservicesapi.postmediaparcelservices.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request blocked)|awswaf|captcha/i;
// API Gateway's answer for a route it does not have.
const NO_ROUTE = /"Missing Authentication Token"/;
const DEFAULT_BUDGET_MS = 15_000;

/** The page's lookup: the number, a plus sign and the postal code, in the path. */
export function postmediaQueryUrl(number: string, postcode: string): string {
  return `${POSTMEDIA_API}/query/${encodeURIComponent(number)}+${encodeURIComponent(postcode)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Postmedia Parcel Services answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned a reply that is not JSON', { cause });
  }
}

export class PostmediaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, postcode: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(postmediaQueryUrl(number, postcode), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTMEDIA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // The page reads a missing parcel from a 200 reply; a redirect, a 404 or a missing route is a moved API.
    const body = decodeText(bytes);
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410
      || (response.status === 403 && NO_ROUTE.test(body.slice(0, 1_000)))) {
      throw new TransportError(PROVIDER, 'Postmedia Parcel Services tracking lookup is unavailable', { status: response.status });
    }
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Postmedia Parcel Services refused the lookup', { status: 403 });
    return parsePostmedia(json(body), number);
  }

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostmediaNumber(raw);
    const postcode = normalizePostmediaPostcode(rawPostcode);
    // A read that fails to reach the tracker, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'postmedia-parcel-services', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, postcode, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, postcode, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostmediaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // The postal code is part of every lookup, so the adapter cannot recognize a number alone.
  return {
    id: 'postmedia-parcel-services', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
