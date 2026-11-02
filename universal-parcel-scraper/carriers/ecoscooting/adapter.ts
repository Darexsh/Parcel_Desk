import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { NoHistoryError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeEcoscootingNumber, parseEcoscooting } from './parser.js';

const ENDPOINT = 'https://de-link.cainiao.com/gateway/link.do';

export class EcoscootingTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeEcoscootingNumber(raw);
    // A query that fails to reach the gateway, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ecoscooting', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(raw, number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(raw, number, signal, remainingMs)),
    ]);
  }

  private async read(raw: string, number: string, signal: AbortSignal, timeoutMs: number) {
    try {
      // Fixed public configuration from Ecoscooting's own anonymous client,
      // not an issued account credential or a guessed merchant signature.
      const body = new URLSearchParams({ logistics_interface: JSON.stringify({ mailNo: number, locale: 'en_US', role: 'endUser' }),
        msg_type: 'CN_OVERSEA_LOGISTICS_INQUIRY_TRACKING', logistic_provider_id: 'DISTRIBUTOR_30250031', data_digest: 'suibianxie', to_code: 'CNL_EU' });
      const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent) }, body: body.toString() },
        { provider: 'Ecoscooting', timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'Ecoscooting'); } catch (cause) { throw new SchemaError('Ecoscooting', 'Ecoscooting returned invalid tracking JSON', { cause }); }
      const result = parseEcoscooting(payload, number);
      // A reference typed without its CN is the carrier's under the full one.
      return number === normalizeTrackingNumber(raw) ? result : { ...result, canonical_tracking_number: number };
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Ecoscooting', 'Ecoscooting tracking endpoint is unavailable', { cause: error });
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EcoscootingTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ecoscooting', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: async (number, context) => {
      try {
        return await recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeEcoscootingNumber(number)));
      } catch (error) {
        // A listing names the parcel, scans or not; a number nobody announced gets the query error.
        if (error instanceof NoHistoryError) return { known: true, lastActivityAt: null };
        throw error;
      }
    } };
};
