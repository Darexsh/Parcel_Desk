import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JNT_CARGO_ENDPOINT, JNT_CARGO_MAX_BYTES, JNT_CARGO_PROVIDER, normalizeJntCargoNumber, parseJntCargoJson } from './parser.js';

export class JntCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeJntCargoNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs)) throw new TypeError('J&T Cargo budget must be finite');
    return runSteps({ carrier: JNT_CARGO_PROVIDER, budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(JNT_CARGO_ENDPOINT, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify({ waybillNo: number, langType: 'EN', searchWaybillOrCustomerOrderId: '1' }),
        }, { provider: JNT_CARGO_PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: JNT_CARGO_MAX_BYTES,
          fetcher: this.options.fetcher });
        signal.throwIfAborted();
        return parseJntCargoJson(decodeText(bytes), number);
      } catch (error) {
        if (signal.aborted) {
          if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') throw new BudgetExceededError(JNT_CARGO_PROVIDER, budgetMs);
          throw signal.reason;
        }
        // Bounded transport diagnostics can contain the waybill or recipient
        // details. Keep the taxonomy and retry window without those payloads.
        if (error instanceof UpstreamHttpError || error instanceof UpstreamNetworkError) {
          const kind = error instanceof UpstreamHttpError && [404, 410].includes(error.status) ? 'transport' : error.kind;
          throw new CarrierError(kind, JNT_CARGO_PROVIDER, `J&T Cargo tracking failed (${kind})`, {
            status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
          });
        }
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JntCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: JNT_CARGO_PROVIDER, recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeJntCargoNumber(number))) };
};
