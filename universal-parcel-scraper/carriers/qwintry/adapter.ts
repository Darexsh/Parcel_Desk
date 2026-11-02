import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeQwintryNumber, parseQwintry, PROVIDER, QWINTRY_MAX_BYTES, QWINTRY_NOT_FOUND } from './parser.js';

/** The page the tracking form on logistics.qwintry.com opens for the number typed in. */
export const QWINTRY_TRACKING = 'https://logistics.qwintry.com/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class QwintryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${QWINTRY_TRACKING}?${new URLSearchParams({ tracking: number })}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: QWINTRY_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Qwintry redirected its tracker', { status: response.status });
    const html = decodeText(bytes);
    if (GONE.includes(response.status)) {
      // The tracker answers a number it has no record of with its own 404 page.
      if (response.status === 404 && QWINTRY_NOT_FOUND.test(html.slice(0, 16_000))) throw new NotFoundError(PROVIDER);
      throw new TransportError(PROVIDER, 'Qwintry tracker is unavailable', { status: response.status });
    }
    return parseQwintry(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeQwintryNumber(raw);
    // A read that fails to reach Qwintry, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'qwintry', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QwintryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'qwintry', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeQwintryNumber(number))),
  };
};
