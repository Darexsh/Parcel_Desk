import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isRecord } from '../../core/types.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeStarexNumber, parseStarex, PROVIDER, STAREX_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on starexglobal.com makes: the number, then `/history`. */
export const STAREX_API = 'https://api.starexglobal.com/api/v1/starex/packages/';
// The API answers only a request that comes from the tracking site.
const SITE = 'https://starexglobal.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Starex answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Starex returned a reply that is not JSON', { cause });
  }
}

/** A 404's `message`, or null when the body is not the API's JSON. */
function message(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
}

export class StarexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeStarexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${STAREX_API}${number}/history`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en', Referer: SITE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: STAREX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const body = decodeText(bytes);
      // A redirect would answer for another path, so for another parcel or none.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Starex redirected its tracking lookup', { status: response.status });
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Starex answered with a browser check', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Starex refused the lookup', { status: 403 });
      if (response.status === 404 || response.status === 410) {
        const said = response.status === 404 ? message(body) : null;
        // The API's answer for a number it does not know: an empty message.
        if (said === '') throw new NotFoundError(PROVIDER);
        // It says "Not found" for every number when the request does not come from its site.
        if (said === 'Not found') throw new ChallengeError(PROVIDER, 'Starex refused the lookup', { status: 404 });
        // A route the API no longer has.
        throw new TransportError(PROVIDER, 'Starex tracking lookup is unavailable', { status: response.status });
      }
      return parseStarex(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'starex-az', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new StarexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'starex-az', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeStarexNumber(number))),
  };
};
