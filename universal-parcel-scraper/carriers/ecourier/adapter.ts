import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ECOURIER_MAX_BYTES, normalizeEcourierNumber, parseEcourier, PROVIDER } from './parser.js';

/** The tracking page on ecourier.com.bd, which the server renders for the ID in its address. */
export const ECOURIER_PAGE = 'https://ecourier.com.bd/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing parcel from a 200 reply: a 404 is a moved route.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The page's address for one ID, as the site's tracking forms open it. */
export function ecourierPageUrl(number: string): string {
  return `${ECOURIER_PAGE}?${new URLSearchParams({ tracking_no: number })}`;
}

export class EcourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(ecourierPageUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ECOURIER_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'eCourier redirected its tracking page', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'eCourier tracking page is unavailable', { status: response.status });
    return parseEcourier(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEcourierNumber(raw);
    // A read that fails to reach eCourier, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'ecourier', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EcourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ecourier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEcourierNumber(number))),
  };
};
