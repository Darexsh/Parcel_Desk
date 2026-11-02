import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ATLANTIC_COURIER_MAX_BYTES, normalizeAtlanticCourierNumber, parseAtlanticCourier, PROVIDER } from './parser.js';

/** The address the tracking page's script posts a number to; it answers the history as an HTML fragment. */
export const ATLANTIC_COURIER_ENDPOINT = 'https://atlanticcourier.net/action';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the lookup answers unknown numbers with a notice.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The body the tracking page's script posts for one whole air waybill: JSON, sent as its form's type. */
export function atlanticCourierLookupBody(raw: string): string {
  return JSON.stringify({ function: 'track', awbno: normalizeAtlanticCourierNumber(raw), searchby: 'A' });
}

export class AtlanticCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(ATLANTIC_COURIER_ENDPOINT, { method: 'POST', signal, body: atlanticCourierLookupBody(number), headers: {
      Accept: 'text/html, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ATLANTIC_COURIER_MAX_BYTES,
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'Atlantic tracking lookup is unavailable', { status: response.status });
    }
    const html = decodeText(bytes);
    if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Atlantic returned an empty reply');
    return parseAtlanticCourier(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAtlanticCourierNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'atlantic-courier', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AtlanticCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'atlantic-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
