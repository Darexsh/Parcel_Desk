import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSamedayNumber, parseSamedayReply, PROVIDER } from './parser.js';

// Each country site's tracker asks its own API host, and each host knows only
// its own network's shipments. Romania, the largest, goes first. Sameday left
// Hungary, so its host is not asked.
const COUNTRIES = ['ro', 'bg'] as const;

/** The history request the country sites' tracker makes, with English wording. */
export function samedayHistoryUrl(country: (typeof COUNTRIES)[number], number: string): string {
  return `https://api.sameday.${country}/api/public/awb/${encodeURIComponent(number)}/awb-history?_locale=en`;
}

export class SamedayTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSamedayNumber(raw);
    return runSteps({ carrier: 'sameday', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      // A number one country does not know can belong to another. Only every
      // country's not-found is a missing parcel; any other failure leaves the
      // answer open.
      let failure: Error | undefined;
      for (const country of COUNTRIES) {
        if (failure && signal.aborted) throw failure;
        signal.throwIfAborted();
        try {
          const { response, bytes } = await fetchBounded(samedayHistoryUrl(country, number), { signal,
            headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
          }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 2_000_000,
            allowHttpStatuses: [404], fetcher: this.options.fetcher });
          const result = parseSamedayReply(response.status, decodeText(bytes), number);
          if (result) return result;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          failure ??= error;
        }
      }
      throw failure ?? new NotFoundError(PROVIDER);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SamedayTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'sameday', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSamedayNumber(number))) };
};
