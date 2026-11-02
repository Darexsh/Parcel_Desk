import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeVenipakNumber, normalizeVenipakParcelNumber, parseVenipak, PROVIDER } from './parser.js';

// The service Venipak's tracking page asks for a number. The Latvian and
// Estonian sites' English pages word every answer in English; the Lithuanian
// one words its notices in Lithuanian.
export const VENIPAK_ENDPOINT = 'https://venipak.com/ee/en/wp-json/v1/shipment-tracker/';
// A shipment's reply is a few kilobytes per parcel.
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// Cloudflare's challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>Just a moment/i;

export function venipakTrackingUrl(raw: string): string {
  return `${VENIPAK_ENDPOINT}${encodeURIComponent(normalizeVenipakNumber(raw).query)}`;
}

export class VenipakTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = venipakTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'application/json',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      // A moved or missing service says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Venipak tracking service is unavailable');
      const text = decodeText(bytes);
      let reply: unknown;
      try {
        reply = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (error) {
        if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER);
        throw new SchemaError(PROVIDER, 'Venipak returned a reply that is not JSON', { cause: error });
      }
      return parseVenipak(reply, raw);
    };
    // A request that fails to reach Venipak, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'venipak', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VenipakTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'venipak', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeVenipakParcelNumber(number))),
  };
};
