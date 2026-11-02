import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isDpdUkReferenceAbsent, normalizeDpdUkNumber, parseDpdUkHistory, parseDpdUkReference, PROVIDER, validateDpdUkParcel } from './parser.js';

const API = 'https://apis.track.dpd.co.uk/v1';

export class DpdUkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDpdUkNumber(raw);
    return runSteps({ carrier: 'dpd-uk', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const read = async (path: string, reference = false): Promise<unknown> => {
        try {
          signal.throwIfAborted();
          const { bytes, response } = await fetchBounded(`${API}${path}`, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
            { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 1_000_000,
              fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
          let payload: unknown;
          try { payload = parseJsonBytes(bytes, PROVIDER); }
          catch { throw response.ok ? new SchemaError(PROVIDER) : new TransportError(PROVIDER, 'DPD UK tracking endpoint is unavailable'); }
          if (!response.ok) {
            if (reference && response.status === 404 && isDpdUkReferenceAbsent(payload)) throw new NotFoundError(PROVIDER);
            throw new TransportError(PROVIDER, 'DPD UK tracking endpoint is unavailable');
          }
          return payload;
        } catch (error) {
          signal.throwIfAborted();
          // Request diagnostics and malformed bodies can contain an issued parcel
          // handle or personal details. Keep the classification, never its cause.
          if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, `${PROVIDER} tracking failed (${error.kind})`,
            { status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
          throw new TransportError(PROVIDER);
        }
      };
      const query = new URLSearchParams({ origin: 'PRTK', postcode: '', referenceNumber: number });
      const code = parseDpdUkReference(await read(`/reference?${query}`, true), number);
      const parcelPath = `/parcels/${encodeURIComponent(code)}`;
      const detail = await read(parcelPath);
      validateDpdUkParcel(detail, number, code);
      const history = await read(`${parcelPath}/parcelevents`);
      return parseDpdUkHistory(detail, history, number, code);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DpdUkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dpd-uk', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // The reference service names a number it does not know, so the lookup answers recognition.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeDpdUkNumber(number))) };
};
