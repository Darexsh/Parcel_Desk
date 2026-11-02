import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FARGO_COURIER_MAX_BYTES, fargoCourierFailure, normalizeFargoCourierNumber, parseFargoCourier, PROVIDER } from './parser.js';

/** The tracker the home page on fargocourier.co.ke frames, and the customer portal's own search opens. */
export const FARGO_COURIER_TRACKER = 'https://portal.fargocourier.co.ke/track';
const REDIRECTS = [301, 302, 303, 307, 308];

export class FargoCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFargoCourierNumber(raw);
    // A request that fails to reach Fargo, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'fargo-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // `blank` leaves out the portal's menus, as in the home page's frame.
    const url = `${FARGO_COURIER_TRACKER}?${new URLSearchParams({ blank: '1', wayBillNumber: number })}`;
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FARGO_COURIER_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 500] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Fargo Courier redirected its tracking lookup');
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Fargo Courier tracking page is unavailable');
    const html = decodeText(bytes);
    if (response.status === 500) fargoCourierFailure(html);
    return parseFargoCourier(html, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FargoCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fargo-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
