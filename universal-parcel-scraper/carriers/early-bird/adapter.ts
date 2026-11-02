import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EARLY_BIRD_MAX_BYTES, earlyBirdErrorCode, normalizeEarlyBirdNumber, parseEarlyBird, PROVIDER } from './parser.js';

// The service earlybird.se/spara-och-hjalp asks, without a key, cookie or token.
export const EARLY_BIRD_ENDPOINT = 'https://earlybird.se/api/tracking';
// Vercel's bot checkpoint or another block page instead of the service's JSON.
const CHALLENGE = /Vercel Security Checkpoint|<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-turnstile|captcha/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The request the tracking page sends for one number, in English. */
export function earlyBirdRequestBody(raw: string): string {
  return JSON.stringify({ trackingNumber: normalizeEarlyBirdNumber(raw), locale: 'en' });
}

export class EarlyBirdTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const body = earlyBirdRequestBody(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The scans are worded in the language asked for; English is the one the map reads first.
      const { response, bytes } = await fetchBounded(EARLY_BIRD_ENDPOINT, { method: 'POST', signal, body, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EARLY_BIRD_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [400, 404, 410, 429] });
      const text = decodeText(bytes);
      if (response.headers.get('x-vercel-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'Early Bird answered with a browser challenge');
      // A missing route says nothing about the parcel: an unknown number is the service's own code.
      const missingRoute = () => new TransportError(PROVIDER, 'Early Bird tracking service is unavailable');
      if (response.status === 410) throw missingRoute();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Early Bird answered with a block page', { cause });
        if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), undefined, { cause });
        if (response.status === 404) throw missingRoute();
        throw new SchemaError(PROVIDER, 'Early Bird returned a reply that is not JSON', { cause });
      }
      if (response.status === 200) return parseEarlyBird(payload, raw);
      const code = earlyBirdErrorCode(payload);
      if (code === 'rate_limited' || response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      if (response.status === 404 && code === 'tracking_not_found') throw new NotFoundError(PROVIDER);
      if (response.status === 400 && code === 'invalid_tracking_number') {
        throw new InvalidInputError(PROVIDER, 'Early Bird does not take this tracking number', { reason: 'wrong_number' });
      }
      throw new IndeterminateError(PROVIDER, 'Early Bird refused the tracking request');
    };
    // A request that fails to reach Early Bird, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'early-bird', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EarlyBirdTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'early-bird', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEarlyBirdNumber(number))),
  };
};
