import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AQUILINE_MAX_BYTES, CARRIER, normalizeAquilineNumber, parseAquiline, PROVIDER } from './parser.js';

/** The Firebase function the tracker at aq-track.com calls with a number, without a session. */
export const AQUILINE_FUNCTION = 'https://europe-west1-aquiline-e398d.cloudfunctions.net/getTrackingStatus';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class AquilineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(AQUILINE_FUNCTION, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ data: { input: number } }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: AQUILINE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404] });
    // A redirect or a missing function is a moved service, not a missing parcel.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Aquiline tracking function moved', { status: response.status });
    let payload: unknown;
    try {
      payload = JSON.parse(decodeText(bytes));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Aquiline returned a reply that is not JSON', { cause: error });
    }
    return parseAquiline(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAquilineNumber(raw);
    // A read that fails to reach the function, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AquilineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAquilineNumber(number))),
  };
};
