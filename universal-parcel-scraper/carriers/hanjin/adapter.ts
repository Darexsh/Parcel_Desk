import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HANJIN_MAX_BYTES, HANJIN_ORIGIN, normalizeHanjinNumber, parseHanjin, PROVIDER } from './parser.js';

// The result page the tracking form posts to, which also answers the number
// in the address.
export const HANJIN_ENDPOINT = `${HANJIN_ORIGIN}/kor/CMS/DeliveryMgr/WaybillResult.do`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: an unknown number gets a notice page.
const GONE = [404, 410];

export class HanjinTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHanjinNumber(raw);
    // `schLang=KR` picks the Korean page; the English one translates the scans loosely.
    const url = `${HANJIN_ENDPOINT}?${new URLSearchParams({ mCode: 'MN038', wblnum: number, schLang: 'KR' })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HANJIN_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Hanjin sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Hanjin tracking page is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Hanjin returned an empty page');
      return parseHanjin(html, number);
    };
    // A request that fails to reach Hanjin, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'hanjin', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HanjinTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hanjin', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHanjinNumber(number))),
  };
};
