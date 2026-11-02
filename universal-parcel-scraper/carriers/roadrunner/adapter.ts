import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRoadrunnerNumber, parseRoadrunner, PROVIDER, ROADRUNNER_MAX_BYTES } from './parser.js';

/** The fragment the tracking portal at `tools.rrts.com/LTLTrack/` loads for each number it looks up. */
export const ROADRUNNER_ENDPOINT = 'https://tools.rrts.com/LTLTrack/TrackingShipment/ShipmentDataTab';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the portal answers unknown PROs with an alert.
const GONE = [404, 410];

/** The fragment's address for one PRO, with the empty application id the portal sends. */
export function roadrunnerLookupUrl(number: string): string {
  return `${ROADRUNNER_ENDPOINT}/${normalizeRoadrunnerNumber(number)}?appIDEncoded=`;
}

export class RoadrunnerTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRoadrunnerNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(roadrunnerLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ROADRUNNER_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Roadrunner redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Roadrunner tracking lookup is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Roadrunner returned an empty reply');
      return parseRoadrunner(html, number);
    };
    // A request that fails to reach Roadrunner, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'roadrunner', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RoadrunnerTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'roadrunner', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRoadrunnerNumber(number))),
  };
};
