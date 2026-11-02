import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeShreeMarutiNumber, parseShreeMaruti, PROVIDER, SHREE_MARUTI_MAX_BYTES } from './parser.js';

/** The lookup the tracker on tracking.shreemaruti.com makes for the number in its address. */
export const SHREE_MARUTI_API = 'https://apis-hubops.innofulfill.com/tracking/v2/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|captcha|<title>\s*(?:403 )?Forbidden/i;

/** How long the service asks a client to wait: `Retry-After`, else the seconds until its window resets. */
function retryAfterMs(response: Response): number | undefined {
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const value = response.headers.get(name)?.trim();
    if (value && /^\d{1,4}$/.test(value)) return Number(value) * 1000;
  }
  return undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shree Maruti answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Shree Maruti returned a reply that is not JSON', { cause });
  }
}

export class ShreeMarutiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShreeMarutiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SHREE_MARUTI_API}${number}`, { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHREE_MARUTI_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 429] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Shree Maruti tracking lookup is unavailable', { status: response.status });
      }
      // The service allows a client 120 lookups a minute.
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), undefined, { status: 429 });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Shree Maruti refused the lookup', { status: 403 });
      return parseShreeMaruti(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'shree-maruti', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShreeMarutiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shree-maruti', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeShreeMarutiNumber(number))),
  };
};
