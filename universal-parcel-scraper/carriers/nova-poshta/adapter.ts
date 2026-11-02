import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps, type StepSpec } from '../../core/runner/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isNovaPoshtaWaybill, normalizeNovaPoshtaNumber, parseNovaPoshta, parseNovaPoshtaHistory } from './parser.js';
const HISTORY_ENDPOINT = 'https://api.novapost.com/site/v.1.0/shipments/tracking/';
const SUMMARY_ENDPOINT = 'https://api.novaposhta.ua/v2.0/json/';
export class NovaPoshtaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeNovaPoshtaNumber(raw);
    const direct: StepSpec<CarrierResult> = { id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${HISTORY_ENDPOINT}${number}`, { signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: 'Nova Poshta', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 422], fetcher: this.options.fetcher });
      const payload = parseJsonBytes(bytes, 'Nova Poshta');
      if (!response.ok) {
        if (response.status === 404 && isRecord(payload) && isRecord(payload.errors) && payload.errors.errorMessage === 'not_found') {
          throw new NotFoundError('Nova Poshta');
        }
        throw new IndeterminateError('Nova Poshta', 'Nova Poshta could not return movement history');
      }
      return parseNovaPoshtaHistory(payload, number);
    } };
    const summary: StepSpec<CarrierResult> = { id: 'summary', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(SUMMARY_ENDPOINT, { method: 'POST', signal, headers: { 'Content-Type': 'application/json',
          'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify({ modelName: 'TrackingDocument', calledMethod: 'getStatusDocuments',
            methodProperties: { Documents: [{ DocumentNumber: number, Phone: '' }], Language: 'EN' }, system: 'Tracking' }) }, {
            provider: 'Nova Poshta', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 500_000, fetcher: this.options.fetcher });
        return parseNovaPoshta(parseJsonBytes(bytes, 'Nova Poshta'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Nova Poshta', 'Nova Poshta tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } };
    // The older status API knows Ukrainian waybills only, so an international number asks the movement feed alone.
    return runSteps({ carrier: 'nova-poshta', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, isNovaPoshtaWaybill(number) ? [direct, summary] : [direct]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new NovaPoshtaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'nova-poshta', recordsSteps: true, steps: ['direct', 'summary'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeNovaPoshtaNumber(number))) };
};
