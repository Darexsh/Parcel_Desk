import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOcaNumber, OCA_MAX_BYTES, parseOca, PROVIDER } from './parser.js';

/** The tracking method of OCA's e-Pak web service, which shop integrations call without an account. */
export const OCA_API = 'https://webservice.oca.com.ar/ePak_tracking/Oep_TrackEPak.asmx/Tracking_Pieza';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the service answers an unknown number with an empty dataset.
const GONE = [404, 410];

export class OcaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOcaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The service needs both account fields, and answers any visitor with them empty.
      const url = `${OCA_API}?${new URLSearchParams({ NroDocumentoCliente: '', CUIT: '', Pieza: number })}`;
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OCA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'OCA moved its tracking service');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'OCA tracking service is unavailable');
      return parseOca(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'oca', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OcaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'oca', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeOcaNumber(number))),
  };
};
