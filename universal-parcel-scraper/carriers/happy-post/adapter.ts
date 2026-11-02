import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HAPPY_POST_MAX_BYTES, normalizeHappyPostNumber, parseHappyPost, PROVIDER } from './parser.js';

/** The lookup the tracking pages on happy-post.com and uk.happy-post.com make, the number after it. */
export const HAPPY_POST_API = 'https://app.happy-post.com/api/v1/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Happy-Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Happy-Post returned a reply that is not JSON', { cause });
  }
}

/** The API view answered: it names the methods it allows, which the site's own pages do not. */
function fromApi(response: Response): boolean {
  return /\bGET\b/.test(response.headers.get('allow') ?? '');
}

export class HappyPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHappyPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${HAPPY_POST_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HAPPY_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const body = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Happy-Post redirected its tracking lookup', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Happy-Post refused the lookup', { status: 403 });
      if (response.status === 404 || response.status === 410) {
        // The API's answer for a number it does not know is an empty 404.
        if (response.status === 404 && fromApi(response) && !body.trim()) throw new NotFoundError(PROVIDER);
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Happy-Post answered with a browser check', { status: response.status });
        if (fromApi(response)) throw new SchemaError(PROVIDER, 'Happy-Post returned an unexpected 404', { status: response.status });
        // The site's HTML 404 page: a route the API no longer has.
        throw new TransportError(PROVIDER, 'Happy-Post tracking lookup is unavailable', { status: response.status });
      }
      return parseHappyPost(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'happy-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HappyPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'happy-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHappyPostNumber(number))),
  };
};
