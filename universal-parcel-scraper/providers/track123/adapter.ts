import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { isRecord } from '../../core/types.js';
import { localEvent, numberOf, place, result, text } from '../shared/result.js';

const SOURCE = 'Track123';
const PAGE = 'https://www.track123.com/carriers/fedex';
export const TRACK123_QUERY = 'https://www.track123.com/tk/api/v2/anonymous/track/query-track-nos';
export const TRACK123_POLL = 'https://www.track123.com/tk/api/v2/anonymous/track/polling-waybill';

export function parseTrack123Response(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || typeof payload.code !== 'string') throw new SchemaError(SOURCE, 'Unreadable tracking reply');
  // A rejected guest request says nothing about shipment existence.
  if (payload.code !== '00000') throw new IndeterminateError(SOURCE, 'The guest tracking request was refused', { reason: 'guest_refused' });
  const records = isRecord(payload.data) ? payload.data.landWaybillLists : null;
  if (!Array.isArray(records) || records.length !== 1 || !isRecord(records[0])) throw new SchemaError(SOURCE, 'No unique shipment');
  const shipment = records[0];
  if (shipment.trackingNo !== number || shipment.localProviderCode !== 'fedex') {
    throw new SchemaError(SOURCE, 'The shipment does not match the requested FedEx number');
  }
  if (shipment.querying !== false) throw new IndeterminateError(SOURCE, 'The provider is still retrieving history', { reason: 'query_pending' });
  if (!Array.isArray(shipment.localDetails) || shipment.localDetails.length > 1000) throw new SchemaError(SOURCE, 'Invalid tracking history');
  if (!shipment.localDetails.length) throw new NoHistoryError(SOURCE, 'No available tracking history');
  const events: CarrierEvent[] = [];
  for (const raw of shipment.localDetails) {
    if (!isRecord(raw) || raw.trackingNo !== number || typeof raw.eventTime !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.eventTime)) throw new SchemaError(SOURCE, 'Unbound or undated tracking event');
    const wall = raw.eventTime.replace(' ', 'T');
    const offset = typeof raw.timezone === 'string' && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(raw.timezone) ? raw.timezone : null;
    const clock = DateTime.fromISO(offset ? wall + offset : wall, { setZone: true, zone: 'UTC' });
    if (!clock.isValid) throw new SchemaError(SOURCE, 'Invalid event clock');
    if (offset && typeof raw.eventTimeUtc === 'string') {
      const utc = DateTime.fromISO(raw.eventTimeUtc.replace(' ', 'T'), { zone: 'UTC' });
      if (!utc.isValid || utc.toMillis() !== clock.toMillis()) throw new SchemaError(SOURCE, 'Conflicting event clocks');
    }
    const event = localEvent(offset ? wall + offset : wall, text(raw.eventDetail) || text(raw.desc));
    if (event) events.push({ ...event, local_time: wall, ...(place(raw.address) ? { location: place(raw.address) } : {}) });
  }
  return { ...result(events, SOURCE), tracking_url: PAGE, reported_carriers: ['FedEx'], discovered_carrier: 'fedex' };
}

export const adapter: AdapterFactory = environment => ({
  id: SOURCE, recordsSteps: true, steps: ['trawl'],
  async track(input, context = {}) {
    const number = numberOf(input.number);
    if (input.carrier !== 'fedex' || !/^(?:\d{12}|\d{15}|\d{20})$/.test(number)) {
      throw new IndeterminateError(SOURCE, 'This provider is enabled only for named FedEx lookups', { reason: 'unsupported_scope' });
    }
    return runSteps({ carrier: SOURCE, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 30_000 }, [{
      id: 'trawl', run: async ({ remainingMs, signal }) => {
        if (!environment.trawl) throw new TransportError(SOURCE, 'A browser service is required');
        const page = await environment.trawl.scrape({ url: `${PAGE}#trawl-number=${number}`, skipHttp: true, maxTier: 3,
          maxTimeout: Math.max(1, Math.floor(remainingMs - 2000)), captureResponses: [TRACK123_QUERY, TRACK123_POLL] },
        { provider: SOURCE, timeoutMs: remainingMs, maxBytes: 5_000_000, fetcher: environment.fetcher, signal, captureWindow: 'last' });
        const entries = page.capturedResponses.filter(row => [TRACK123_QUERY, TRACK123_POLL].includes(row.url)
          && row.trackingNumberSubmitted === number);
        const last = entries.at(-1);
        if (!last) throw new ChallengeError(SOURCE, 'The public page did not complete guest tracking', { reason: 'guest_verification' });
        if ([401, 403].includes(last.status)) throw new ChallengeError(SOURCE, 'The guest tracking request was challenged');
        if (last.status >= 400) throw new UpstreamHttpError(SOURCE, last.status);
        if (last.status !== 200 || last.truncated || last.error || !last.body) throw new TransportError(SOURCE, 'Incomplete guest tracking response');
        let payload: unknown;
        try { payload = JSON.parse(last.body); } catch { throw new SchemaError(SOURCE, 'Unreadable guest tracking response'); }
        return parseTrack123Response(payload, number);
      },
    }]);
  },
});
