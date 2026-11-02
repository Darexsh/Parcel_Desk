import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeStallionNumber, parseStallion, PROVIDER, STALLION_MAX_BYTES } from './parser.js';

/** The WordPress action the tracking page posts its number to. */
export const STALLION_ENDPOINT = 'https://stallion.ca/wp-admin/admin-ajax.php';
const ACTION = 'se_track_form_submission';
// Cloudflare's challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;
// The throttle names its wait in whole seconds; one more second covers the rounding.
const THROTTLE_MARGIN_MS = 1_000;
// The longest throttle wait worth sitting out, as for a short Retry-After.
const MAX_THROTTLE_WAIT_MS = 60_000;
// What the lookup sent again after the throttle keeps at least for its request.
const RESEND_MS = 2_000;

/** The wait the site's throttle asks for, with its margin; null when it names none or a long one. */
function throttleWaitMs(error: unknown): number | null {
  if (!(error instanceof RateLimitedError) || error.retryAfterMs === undefined) return null;
  return error.retryAfterMs <= MAX_THROTTLE_WAIT_MS ? error.retryAfterMs + THROTTLE_MARGIN_MS : null;
}

/** Waits `ms`; false when the lookup's signal ended the wait first. */
function paused(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class StallionTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { number } = normalizeStallionNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { bytes } = await fetchBounded(STALLION_ENDPOINT, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ tracking_number: number, action: ACTION }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: STALLION_MAX_BYTES, fetcher: this.options.fetcher });
      // The page answers JSON as HTML; WordPress answers "0" for an action it no longer has.
      const text = decodeText(bytes);
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'Stallion Express answered with a browser challenge', { cause });
        throw new SchemaError(PROVIDER, 'Stallion Express returned a reply that is not JSON', { cause });
      }
      if (typeof reply === 'number') throw new IndeterminateError(PROVIDER, 'Stallion Express tracking action is unavailable');
      return parseStallion(reply, raw);
    };
    const budgetMs = context.budgetMs ?? 15_000;
    const deadline = performance.now() + budgetMs;
    // The throttle is sat out only when its wait and the request after it fit in what is left.
    const throttleFits = (error: unknown) => {
      const wait = throttleWaitMs(error);
      return wait !== null && wait + RESEND_MS <= deadline - performance.now();
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. So does one
    // the site throttled, once the wait it named is over.
    return runSteps({ carrier: 'stallion-express', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      { id: 'retry', recovers: (error) => isNetworkFailure(error) || throttleFits(error),
        run: async ({ signal, remainingMs, previousError }) => {
          const wait = throttleWaitMs(previousError);
          if (wait === null) return read(signal, remainingMs);
          // A wait the lookup's end cuts short leaves the throttle as the answer.
          if (wait + RESEND_MS > remainingMs || !await paused(wait, signal)) throw previousError;
          return read(signal, remainingMs - wait);
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new StallionTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'stallion-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeStallionNumber(number))),
  };
};
