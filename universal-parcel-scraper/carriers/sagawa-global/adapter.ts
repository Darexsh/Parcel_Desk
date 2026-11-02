import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSagawaGlobalNumber, parseSagawaGlobal, PROVIDER, SAGAWA_GLOBAL_MAX_BYTES } from './parser.js';

/** The SGX tracker the form on SGH Global Japan's support page opens. */
export const SAGAWA_GLOBAL_TRACKER = 'https://tracking.sagawa-sgx.com/sgx/trackeng.asp';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's address for one air waybill, as the support page's form builds it, with the English page. */
export function sagawaGlobalLookupUrl(number: string): string {
  return `${SAGAWA_GLOBAL_TRACKER}?ENC=ENG&CAT=AWB&AWB=${encodeURIComponent(number)}`;
}

export class SagawaGlobalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSagawaGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(sagawaGlobalLookupUrl(number), { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SAGAWA_GLOBAL_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      // An unknown air waybill is HTTP 200 with No Record.: a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SGX tracking page is unavailable');
      return parseSagawaGlobal(decodeText(bytes), number);
    };
    // A read that fails to reach the tracker, or hangs, gets one more: the first gets half of
    // the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sagawa-global', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SagawaGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sagawa-global', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSagawaGlobalNumber(number))),
  };
};
