import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { KEX_MAX_BYTES, normalizeKexNumber, parseKex, PROVIDER } from './parser.js';

/** The tracking page, which also answers the lookup it makes for the numbers in its `track` parameter. */
export const KEX_TRACK_PAGE = 'https://th.kex-express.com/en/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// The page's separator between the parts of its `track` parameter, "|||" in base64.
const SEPARATOR = 'fHx8';
// Bot checks Cloudflare, in front of the site, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

/** Thirty-two random hex digits, as the page's own padding. */
function randomHex(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The address the page's search sends its lookup to: the number between two
 * random hex strings on each side, joined with the page's separator and
 * encoded in base64. The tracker reads the number from it; a bare number in
 * `track` gets no answer.
 */
export function kexLookupUrl(number: string, padding: () => string = randomHex): string {
  const track = btoa([padding(), padding(), number, padding(), padding()].join(SEPARATOR));
  return `${KEX_TRACK_PAGE}?track=${encodeURIComponent(track)}`;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim() ?? '';
  return /^\d{1,5}$/.test(value) ? Number(value) * 1000 : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'KEX Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'KEX Express returned a reply that is not JSON', { cause });
  }
}

/** Whether an error reply asks for the page's slider captcha, as the page reads it. */
function asksForCaptcha(body: string): boolean {
  try {
    const reply: unknown = JSON.parse(body);
    return isRecord(reply) && reply.needCaptcha === true;
  } catch {
    return false;
  }
}

/** An answer other than the lookup's reply: the captcha, a rate limit, a refusal or a moved route. */
function refusal(response: Response, body: string): never {
  const { status } = response;
  if (asksForCaptcha(body)) throw new ChallengeError(PROVIDER, 'KEX Express asked for its slider captcha', { status });
  if (status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'KEX Express rate limited the lookup', { status });
  if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'KEX Express tracking lookup is unavailable', { status });
  if (status === 403 || CHALLENGE.test(body)) throw new ChallengeError(PROVIDER, 'KEX Express refused the lookup', { status });
  // The page tries a 401 again and then shows nothing; it says nothing about the parcel.
  throw new IndeterminateError(PROVIDER, 'KEX Express did not take the lookup', { status });
}

export class KexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(kexLookupUrl(number), { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'kett-lang': 'en',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ tracking_no: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: KEX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 401, 403, 429] });
      const body = decodeText(bytes);
      if (response.status !== 200) refusal(response, body.slice(0, 64_000));
      // The reply is JSON whatever its content type says.
      return parseKex(json(body), number);
    };
    // A lookup that fails to reach KEX, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'kex', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKexNumber(number))),
  };
};
