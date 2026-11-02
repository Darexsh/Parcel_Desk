import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FASTBOX_MAX_BYTES, normalizeFastboxNumber, parseFastbox, PROVIDER } from './parser.js';

/** Fastbox's tracking page, which looks the invoice up on the server. */
export const FASTBOX_TRACKER = 'https://fastbox.co.kr/DHUB/tracking.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers every invoice with HTTP 200; a missing route is not a missing parcel.
const GONE = [404, 410];

export function fastboxTrackerUrl(number: string): string {
  return `${FASTBOX_TRACKER}?${new URLSearchParams({ fb_invoice_no: normalizeFastboxNumber(number) })}`;
}

export class FastboxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFastboxNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(fastboxTrackerUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FASTBOX_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Fastbox redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Fastbox tracking page is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Fastbox refused the lookup', { status: 403 });
      return parseFastbox(decodeText(bytes), number);
    };
    // A lookup that fails to reach Fastbox, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fastbox', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FastboxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fastbox', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFastboxNumber(number))),
  };
};
