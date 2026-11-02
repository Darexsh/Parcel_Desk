import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSapxNumber, parseSapx, PROVIDER, SAPX_MAX_BYTES, sapxLookupNumber } from './parser.js';

// The tracker's result page for one resi, rendered on the server. The search
// form posts up to twenty numbers to `/id/cek-awb` and renders the same
// tables; this address needs no cookie, token, CAPTCHA or phone digits.
export const SAPX_ENDPOINT = 'https://www.sapx.id/id/cek-awb/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: an unknown number gets a notice on the page.
const GONE = [404, 410];

export class SapxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSapxNumber(raw);
    const url = `${SAPX_ENDPOINT}${encodeURIComponent(sapxLookupNumber(number))}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SAPX_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SAPX redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'SAPX tracking page is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'SAPX refused the lookup', { status: 403 });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'SAPX returned an empty page');
      return parseSapx(html, number);
    };
    // A request that fails to reach SAPX, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'sapx-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SapxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sapx-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSapxNumber(number))),
  };
};
