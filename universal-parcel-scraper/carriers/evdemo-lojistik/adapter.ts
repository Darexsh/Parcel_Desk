import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, EVDEMO_MAX_BYTES, normalizeEvdemoNumber, parseEvdemo, PROVIDER } from './parser.js';

/** The tracking page, which looks up the number in its address. */
export const EVDEMO_PAGE = 'https://www.evdemolojistik.com/takip';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number with a notice: a missing route is not a missing shipment.
const GONE = [404, 405, 410];

/** The tracking page's address for a number, as its form and its links build it. */
export function evdemoLookupUrl(number: string): string {
  return `${EVDEMO_PAGE}?${new URLSearchParams({ kargo_kodu: number })}`;
}

export class EvdemoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEvdemoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(evdemoLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EVDEMO_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const status = response.status;
      if (status === 403) throw new ChallengeError(PROVIDER, 'Evdemo Lojistik refused the lookup', { status });
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Evdemo Lojistik tracking page is unavailable', { status });
      return parseEvdemo(decodeText(bytes), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EvdemoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEvdemoNumber(number))),
  };
};
