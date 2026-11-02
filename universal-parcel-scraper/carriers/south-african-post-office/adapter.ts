import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSouthAfricanPostNumber, parseSouthAfricanPost, PROVIDER, SOUTH_AFRICAN_POST_MAX_BYTES } from './parser.js';

/** The Post Office's tracker, whose form sends the number back to the same page as `ParcelId`. */
export const SOUTH_AFRICAN_POST_TRACKER = 'https://trackingnew.postoffice.co.za/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item: the tracker answers unknown numbers with a notice.
const GONE = [404, 410];

export class SouthAfricanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSouthAfricanPostNumber(raw);
    const url = `${SOUTH_AFRICAN_POST_TRACKER}?${new URLSearchParams({ ParcelId: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SOUTH_AFRICAN_POST_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'The South African Post Office sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The South African Post Office tracker is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'The South African Post Office refused the lookup', { status: 403 });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'The South African Post Office returned an empty page');
      return parseSouthAfricanPost(html, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'south-african-post-office', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SouthAfricanPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'south-african-post-office', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSouthAfricanPostNumber(number))),
  };
};
