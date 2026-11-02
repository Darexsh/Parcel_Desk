import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GS_POSTBOX_MAX_BYTES, normalizeGsPostboxNumber, parseGsPostboxPage, PROVIDER } from './parser.js';

/** The page the tracking form on cvsnet.co.kr opens for the number typed in. */
export const GS_POSTBOX_TRACKER = 'https://www.cvsnet.co.kr/invoice/tracking.do';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number itself: a missing route is not a missing parcel.
const GONE = [404, 410];

export class GsPostboxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGsPostboxNumber(raw);
    const url = `${GS_POSTBOX_TRACKER}?${new URLSearchParams({ invoice_no: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GS_POSTBOX_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GS Postbox redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'GS Postbox tracking page is unavailable', { status: response.status });
      return parseGsPostboxPage(decodeText(bytes), number);
    };
    // A request that fails to reach GS Postbox, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'gs-postbox', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GsPostboxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gs-postbox', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGsPostboxNumber(number))),
  };
};
