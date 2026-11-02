import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { NATIONEX_MAX_BYTES, normalizeNationexNumber, parseNationex, PROVIDER } from './parser.js';

// The service Nationex's tracker asks for the number in its address.
export const NATIONEX_ENDPOINT = 'https://nationex.com/api/nationex/get-shipment/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: an unknown number gets a notice with HTTP 200.
const GONE = [404, 410];
// Cloudflare's challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

export function nationexTrackingUrl(raw: string): string {
  return `${NATIONEX_ENDPOINT}${normalizeNationexNumber(raw)}`;
}

export class NationexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = nationexTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page posts this request with its session's CSRF token; the service
      // answers the same shipment to a plain GET without a cookie or token.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: NATIONEX_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Nationex moved its tracking service');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Nationex tracking service is unavailable');
      const body = decodeText(bytes);
      let reply: unknown;
      try {
        reply = JSON.parse(body);
      } catch (error) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nationex answered with a browser challenge', { cause: error });
        throw new SchemaError(PROVIDER, 'Nationex returned a reply that is not JSON', { cause: error });
      }
      return parseNationex(reply, raw);
    };
    // A request that fails to reach Nationex, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'nationex', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NationexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'nationex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNationexNumber(number))),
  };
};
