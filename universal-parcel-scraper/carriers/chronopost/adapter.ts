import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CHRONOPOST_MAX_BYTES, CHRONOPOST_NAMESPACE, normalizeChronopostNumber, parseChronopostTrackingXml } from './parser.js';

// The official WSDL declares this read-only operation without account credentials.
const ENDPOINT = 'https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS';

export class ChronopostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChronopostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(ENDPOINT, {
        method: 'POST', signal,
        headers: { Accept: 'text/xml', 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""',
          'User-Agent': userAgentOf(this.options.userAgent) },
        body: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:trk="${CHRONOPOST_NAMESPACE}">`
          + `<soap:Body><trk:trackSkybillV2><language>fr_FR</language><skybillNumber>${number}</skybillNumber>`
          + '</trk:trackSkybillV2></soap:Body></soap:Envelope>',
      }, { provider: 'Chronopost tracking', timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: CHRONOPOST_MAX_BYTES, allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      // An HTTP route failure is not the service's positive unknown-parcel reply.
      if ([404, 410].includes(response.status)) throw new IndeterminateError('Chronopost', 'Chronopost tracking endpoint is unavailable');
      return parseChronopostTrackingXml(decodeText(bytes), number);
    };
    // A request that fails to reach Chronopost, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'chronopost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ChronopostTracker(environment);
  return {
    id: 'chronopost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChronopostNumber(number))),
  };
};
