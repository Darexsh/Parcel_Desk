import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  normalizeSpsNumber, parseSpsParcelStatus, parseSpsSearch, parseSpsShipment, SPS, SPS_MAX_BYTES, spsParcelStatusTarget,
} from './parser.js';

// The service the tracking page (www.sps-sro.sk/moja-zasielka) calls from the visitor's browser.
export const SPS_API = 'https://backend.sps-sro.sk/api/tracking/';

interface Reply {
  readonly status: number;
  readonly payload: unknown;
}

export class SlovakParcelServiceTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpsNumber(raw);
    const get = async (path: string, signal: AbortSignal, deadline: number, allowHttpStatuses: readonly number[]): Promise<Reply> => {
      // The service words its notices and scans in Slovak, the language its not-found notice is pinned in.
      const { response, bytes } = await fetchBounded(`${SPS_API}${path}`, { signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'sk', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: SPS, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: SPS_MAX_BYTES,
        allowHttpStatuses, fetcher: this.options.fetcher });
      const text = decodeText(bytes);
      try {
        return { status: response.status, payload: JSON.parse(text) };
      } catch (error) {
        // A gateway's own error page, or a page for a route that moved, says nothing about the parcel.
        if (response.status !== 200) throw new IndeterminateError(SPS, `Slovak Parcel Service returned HTTP ${response.status} without its error reply`, { cause: error });
        if (/<(?:!doctype|html|head|body)\b/i.test(text)) throw new ChallengeError(SPS, 'Slovak Parcel Service answered with a web page instead of its tracking reply', { cause: error });
        throw new SchemaError(SPS, 'Slovak Parcel Service returned a reply that is not JSON', { cause: error });
      }
    };
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The shipment, the search and the parcel's own scans share the step's time.
      const deadline = Date.now() + timeoutMs;
      const id = encodeURIComponent(number);
      const shipment = await get(`shipment?shipment_id=${id}`, signal, deadline, [404, 502]);
      if (shipment.status === 404) throw new IndeterminateError(SPS, 'Slovak Parcel Service tracking service moved');
      if (shipment.status === 502) {
        // One failure answers both an unknown number and a shipment whose history did
        // not load: the search the page runs first tells them apart.
        if (!isRecord(shipment.payload) || shipment.payload.ok !== false) throw new SchemaError(SPS, 'Slovak Parcel Service returned an unexpected error reply');
        const search = await get(`find-shipment?shipment_id=${id}&source=tracking`, signal, deadline, [404]);
        return parseSpsSearch(search.status, search.payload);
      }
      // A shipment without scans has them under its dashed parcel number, as the page asks.
      const parcel = spsParcelStatusTarget(shipment.payload, number);
      if (!parcel) return parseSpsShipment(shipment.payload, number);
      const scans = await get(`parcel-status?parcel_id=${encodeURIComponent(parcel)}`, signal, deadline, [404]);
      // The shipment exists, so a missing route or parcel leaves only its history open.
      if (scans.status === 404) throw new IndeterminateError(SPS, 'Slovak Parcel Service did not return the parcel’s scans');
      return parseSpsShipment(shipment.payload, number, parseSpsParcelStatus(scans.payload, parcel));
    };
    // A request that fails to reach SPS, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'slovak-parcel-service', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SlovakParcelServiceTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'slovak-parcel-service', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpsNumber(number))),
  };
};
