import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePacksNumber, normalizePacksPostcode, PACKS_MAX_BYTES, parsePacks, PROVIDER } from './parser.js';

/** Packs' tracking page, which its form posts the number and postcode back to. */
export const PACKS_TRACKING_PAGE = 'https://www.packs.nl/track-trace/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing parcel: an unknown number gets the page's own notice.
const GONE = [404, 410];

export class PacksTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePacksNumber(raw);
    const postcode = normalizePacksPostcode(rawPostcode);
    // The form's fields, as its submit button sends them.
    const body = new URLSearchParams({ zendingnr: number, postcode, searchcode: 'Zoeken' }).toString();
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(PACKS_TRACKING_PAGE, { method: 'POST', body, signal, headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PACKS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Packs tracking page is unavailable', { status: response.status });
      }
      return parsePacks(decodeText(bytes), number);
    };
    // A lookup that fails to reach Packs, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'packs', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PacksTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // The postcode is part of every lookup, so the adapter cannot recognize a number alone.
  return {
    id: 'packs', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
