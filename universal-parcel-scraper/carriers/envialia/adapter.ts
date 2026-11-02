import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ENVIALIA_MAX_BYTES, ENVIALIA_NAMESPACE, normalizeEnvialiaNumber, parseEnvialiaStatusXml, PROVIDER } from './parser.js';

// The official Alina app's guest search posts here, without an account, a postcode or a device id.
export const ENVIALIA_ENDPOINT = 'https://app.ontime.es/axis2/services/EnvialiaMobileService2.00.02.EnvialiaMobileService2.00.02HttpSoap12Endpoint';

/** The app's request: search type T is a tracking number; the postcode and device id stay empty. */
export function envialiaRequestBody(number: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ser="${ENVIALIA_NAMESPACE}"><soap:Body>`
    + `<ser:buscarEstadoEnvio2><ser:strValor>${number}</ser:strValor><ser:strTipoBusqueda>T</ser:strTipoBusqueda>`
    + '<ser:strCodPostal></ser:strCodPostal><ser:strIdMovil></ser:strIdMovil></ser:buscarEstadoEnvio2>'
    + '</soap:Body></soap:Envelope>';
}

export class EnvialiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEnvialiaNumber(raw);
    return runSteps({ carrier: 'envialia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(ENVIALIA_ENDPOINT, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/soap+xml;charset=utf-8;action="urn:buscarEstadoEnvio2"',
            'User-Agent': userAgentOf(this.options.userAgent) },
          body: envialiaRequestBody(number) },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: ENVIALIA_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number is an empty reply; a missing route is not a missing shipment.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Envialia tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      return parseEnvialiaStatusXml(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EnvialiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'envialia', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEnvialiaNumber(number))) };
};
