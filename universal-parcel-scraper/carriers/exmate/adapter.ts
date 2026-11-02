import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EXMATE_MAX_BYTES, normalizeExmateNumber, parseExmate, PROVIDER } from './parser.js';

/** The page the tracking form on pod.exmate.net opens for the number typed in. */
export const EXMATE_TRACKING = 'https://pod.exmate.net/pod/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class ExmateTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${EXMATE_TRACKING}?${new URLSearchParams({ exmno: number })}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      // The page's language choice. Without it the tracker first sends a
      // known number through its language switch, which sets this cookie.
      Cookie: 'UseLang=EN',
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EXMATE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The tracker answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Exmate redirected its tracker', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Exmate tracker is unavailable', { status: response.status });
    return parseExmate(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExmateNumber(raw);
    // A read that fails to reach Exmate, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'exmate', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExmateTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'exmate', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
