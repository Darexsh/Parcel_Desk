import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSaudiPostNumber, parseSaudiPost, PROVIDER, SAUDI_POST_MAX_BYTES } from './parser.js';

/** The lookup SPL's tracking page makes for the numbers in its address. */
export const SAUDI_POST_API = 'https://splonline.com.sa/umbraco/api/tools/trackshipment';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page the site's firewall serves, with HTTP 200, instead of a request it refuses.
const REJECTED = /<title>\s*Request Rejected\s*<\/title>|The requested URL was rejected/i;
// Bot checks a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    const head = body.slice(0, 64_000);
    if (REJECTED.test(head)) throw new ChallengeError(PROVIDER, 'Saudi Post\'s firewall rejected the lookup', { cause });
    if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'Saudi Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Saudi Post returned a reply that is not JSON', { cause });
  }
}

export class SaudiPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSaudiPostNumber(raw);
    const url = `${SAUDI_POST_API}?${new URLSearchParams({ language: 'en', shipmentCode: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SAUDI_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The page reads a missing parcel from a 200 reply; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'Saudi Post tracking lookup is unavailable');
      return parseSaudiPost(json(decodeText(bytes)), number);
    };
    // A read that fails to reach SPL, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'saudi-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SaudiPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'saudi-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSaudiPostNumber(number))),
  };
};
