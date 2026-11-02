import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BOMBINO_MAX_BYTES, normalizeBombinoNumber, parseBombino, PROVIDER } from './parser.js';

/** The lookup the tracking page on bombinoexp.com makes for each air waybill it opens. */
export const BOMBINO_API = 'https://www.bombinoexp.com/api/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number gets the lookup's message with HTTP 200.
const GONE = [404, 410];
// Vercel's bot checkpoint, or another block page, in place of the reply.
const CHALLENGE = /Vercel Security Checkpoint|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

export class BombinoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBombinoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${BOMBINO_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BOMBINO_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
      const body = decodeText(bytes);
      const challenge = (cause?: unknown) => new ChallengeError(PROVIDER, 'Bombino Express answered with a browser check',
        { cause, status: response.status });
      if (response.headers.get('x-vercel-mitigated') === 'challenge') throw challenge();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw challenge(cause);
        if (response.ok) throw new SchemaError(PROVIDER, 'Bombino Express returned a reply that is not JSON', { cause });
      }
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'Bombino Express limited the lookups', { status: 429 });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Bombino Express redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Bombino Express tracking lookup is unavailable', { status: response.status });
      return parseBombino(payload, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bombino', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BombinoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bombino', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBombinoNumber(number))),
  };
};
