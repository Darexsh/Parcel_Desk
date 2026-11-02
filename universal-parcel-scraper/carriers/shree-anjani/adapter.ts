import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeShreeAnjaniNumber, parseShreeAnjani, PROVIDER, SHREE_ANJANI_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on shreeanjani.co.in makes for the number in its address. */
export const SHREE_ANJANI_API = 'https://api-customer.shreeanjani.co.in/public/awb/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|challenges\.cloudflare\.com|captcha|<title>\s*(?:403 )?Forbidden/i;

/** How long the service asks a client to wait: `Retry-After`, else the seconds until its window resets. */
function retryAfterMs(response: Response): number | undefined {
  for (const name of ['retry-after', 'ratelimit-reset', 'x-ratelimit-reset']) {
    const value = response.headers.get(name)?.trim();
    if (value && /^\d{1,4}$/.test(value)) return Number(value) * 1000;
  }
  return undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shree Anjani answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Shree Anjani returned a reply that is not JSON', { cause });
  }
}

export class ShreeAnjaniTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShreeAnjaniNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SHREE_ANJANI_API}${number}`, { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHREE_ANJANI_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403, 429] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Shree Anjani tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), undefined, { status: 429 });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Shree Anjani refused the lookup', { status: 403 });
      const body = json(decodeText(bytes));
      if (response.status === 400) {
        // The lookup checks the number itself and names the field it refused.
        if (isRecord(body) && body.success === false && /validation/i.test(String(body.error))) {
          throw new InvalidInputError(PROVIDER, 'Shree Anjani refused the number', { reason: 'wrong_number' });
        }
        throw new SchemaError(PROVIDER, 'Shree Anjani refused the lookup', { status: 400 });
      }
      return parseShreeAnjani(body, number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'shree-anjani', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShreeAnjaniTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shree-anjani', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeShreeAnjaniNumber(number))),
  };
};
