import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BLUEEX_MAX_BYTES, normalizeBlueexNumber, parseBlueex, PROVIDER } from './parser.js';

/** The lookup the tracking page on blue-ex.com sends the number in its address to. */
export const BLUEEX_LOOKUP = 'https://www.blue-ex.com/assets/config/tracking/trackall.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class BlueexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's script posts the numbers as a list, with the site's name as the type.
    const body = new URLSearchParams([['tracking_numbers[]', number], ['type', 'blueex']]);
    const { response, bytes } = await fetchBounded(BLUEEX_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: body.toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BLUEEX_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The lookup answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'BlueEX redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'BlueEX tracking lookup is unavailable', { status: response.status });
    return parseBlueex(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBlueexNumber(raw);
    // A read that fails to reach BlueEX, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: 'blueex', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BlueexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'blueex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBlueexNumber(number))),
  };
};
