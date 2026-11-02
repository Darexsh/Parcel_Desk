import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { WE_WORLD_MAX_BYTES, CARRIER, normalizeWeWorldNumber, parseWeWorld, PROVIDER } from './parser.js';

/** The endpoint the tracking page calls with its numbers, without a session or CAPTCHA. */
export const WE_WORLD_TRACK = 'https://www.weworldexpress.com/wwe/queryTrack2';
const REDIRECTS = [301, 302, 303, 307, 308];
// The endpoint takes about eleven seconds to answer, found or not.
const DEFAULT_BUDGET_MS = 30_000;

export class WeWorldTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(WE_WORLD_TRACK, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ orderIds: [number], language: 'en_US' }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: WE_WORLD_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404] });
    // A redirect or a missing endpoint is a moved service, not a missing parcel.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'We World Express tracking endpoint moved', { status: response.status });
    let payload: unknown;
    try {
      payload = JSON.parse(decodeText(bytes));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'We World Express returned a reply that is not JSON', { cause: error });
    }
    return parseWeWorld(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWeWorldNumber(raw);
    // A read that fails to reach the endpoint, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WeWorldTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
