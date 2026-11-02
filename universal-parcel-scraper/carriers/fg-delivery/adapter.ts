import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FG_DELIVERY_MAX_BYTES, normalizeFgDeliveryNumber, parseFgDelivery, PROVIDER } from './parser.js';

/** The lookup the tracking page on fgdelivery.it makes for the number typed in. */
export const FG_DELIVERY_API = 'https://tracking.fgdelivery.it/GetTrack';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing parcel from an empty list: a missing route is a moved lookup.
const GONE = [404, 410];

/** The lookup's address for one number, as the page builds it. */
export function fgDeliveryLookupUrl(number: string): string {
  return `${FG_DELIVERY_API}?${new URLSearchParams({ IdSpedizione: number }).toString()}`;
}

export class FgDeliveryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFgDeliveryNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(fgDeliveryLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FG_DELIVERY_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'FG Delivery redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'FG Delivery tracking lookup is unavailable', { status: response.status });
      // The tracking host's FortiWeb firewall answers what it refuses with its "Web Page Blocked" page.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'FG Delivery\'s firewall refused the lookup', { status: 403 });
      return parseFgDelivery(decodeText(bytes), number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fg-delivery', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FgDeliveryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fg-delivery', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFgDeliveryNumber(number))),
  };
};
