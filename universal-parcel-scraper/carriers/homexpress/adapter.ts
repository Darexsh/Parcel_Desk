import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { getJson, orderRouteUrl } from '../ewe/trace.js';
import { SECTIGO_DV_R36 } from './certificate.js';
import { normalizeHomexpressNumber, parseHomexpressTrace, PROVIDER } from './parser.js';

/** The lookup the tracking page on www.homexpress.com.au makes for the number typed in. */
export const HOMEXPRESS_TRACE = 'https://www.homexpress.com.au/api/trace/orderRoute';
export const homexpressTraceUrl = (number: string) => orderRouteUrl(HOMEXPRESS_TRACE, number);
// The tracker sends its certificate without the intermediate, which Node does not fetch itself.
let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([SECTIGO_DV_R36]);

export class HomexpressTracker {
  readonly #fetcher: typeof fetch;

  /** Over the global fetch, the tracker trusts the intermediate its certificate needs; a host's own fetcher is used as given. */
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    this.#fetcher = transportOf(options.fetcher) === undefined ? trustingFetch() : options.fetcher!;
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const payload = await getJson(homexpressTraceUrl(number), PROVIDER, signal, timeoutMs,
      { fetcher: this.#fetcher, userAgent: this.options.userAgent });
    return parseHomexpressTrace(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHomexpressNumber(raw);
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'homexpress', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HomexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'homexpress', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
