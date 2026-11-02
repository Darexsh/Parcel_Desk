import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { canparNumber, normalizeCanparNumber, parseCanpar, type CanparNumber } from './parser.js';

const API = 'https://canship.canpar.com/api/CanparAddons';

/**
 * The request Canpar's page makes for a number: a delivery notice has its own
 * lookup, and a short barcode with its destination postal code another; every
 * other number, a short barcode without one included, is asked as a barcode.
 */
export function canparRequest({ number, kind }: CanparNumber, postcode = ''): { url: string; body: Record<string, unknown> } {
  if (kind === 'notice') return { url: `${API}/trackByDeliveryNotice`, body: { delivery_notice: number } };
  if (kind === 'short' && postcode) return { url: `${API}/trackByShortBarcodeAndPostalCode`, body: { barcode: number, postal_code: postcode } };
  return { url: `${API}/trackByBarcodeV2`, body: { barcode: number, track_shipment: false } };
}

export class CanparTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** A postcode is used only with a short barcode: every other number finds its parcel alone. */
  async fetch(raw: string, context: TrackingContext = {}, postcode?: string | null) {
    const asked = canparNumber(raw);
    const { url, body } = canparRequest(asked, asked.kind === 'short' ? (postcode ?? '').toUpperCase().replace(/\s+/g, '') : '');
    return runSteps({ carrier: 'canpar', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(url, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify(body),
      }, { provider: 'Canpar', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      if (response.status !== 200) throw new TransportError('Canpar', 'Canpar tracking endpoint is unavailable');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'Canpar'); }
      catch (cause) { throw new SchemaError('Canpar', 'Canpar returned invalid tracking JSON', { cause }); }
      return parseCanpar(payload, asked.number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CanparTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'canpar', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context, input.postcode),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCanparNumber(number))) };
};
