import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { APPLE_EXPRESS_MAX_BYTES, appleExpressOrderFor, normalizeAppleExpressNumber, parseAppleExpress, PROVIDER } from './parser.js';

/** The tracking API the page on track.appleexpress.com reads. */
export const APPLE_EXPRESS_API = 'https://trackapi.appleexpress.com/api/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Imperva, which fronts the tracking page, or another firewall could put in place of the reply.
const CHALLENGE = /_Incapsula_Resource|Incapsula incident|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;

/** The order lookup's address for an order number or a reference, in English. */
export function appleExpressOrderUrl(number: string): string {
  return `${APPLE_EXPRESS_API}/order/${encodeURIComponent(number)}/language/en`;
}

/** The address of the list of orders a reference names, which the page's search asks first. */
export function appleExpressOrdersUrl(reference: string): string {
  return `${APPLE_EXPRESS_API}/trackmultiple/${encodeURIComponent(reference)}/language/en`;
}

/** Seconds in a Retry-After header, as the service sends them, in milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
  return header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

export class AppleExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async json(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: APPLE_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 429] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Apple Express redirected its tracking lookup');
    // The service answers an unknown number with HTTP 200; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Apple Express tracking lookup is unavailable', { status: response.status });
    }
    // It counts the lookups of each address an hour, and answers past its quota with when to ask again.
    if (response.status === 429) {
      throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')),
        'Apple Express refused more lookups of this number for now', { status: 429 });
    }
    const body = decodeText(bytes);
    try {
      return JSON.parse(body);
    } catch (cause) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Apple Express answered with a browser check', { cause });
      throw new SchemaError(PROVIDER, 'Apple Express returned a reply that is not JSON', { cause });
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const asked = normalizeAppleExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, deadline - performance.now());
      if (asked.kind === 'order') return parseAppleExpress(await this.json(appleExpressOrderUrl(asked.number), signal, left()), asked.number);
      // A reference opens the one order the list names for it, by that order's own number.
      const order = appleExpressOrderFor(await this.json(appleExpressOrdersUrl(asked.number), signal, left()), asked.number);
      return parseAppleExpress(await this.json(appleExpressOrderUrl(order), signal, left()), asked.number, order);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'apple-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AppleExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'apple-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAppleExpressNumber(number))),
  };
};
