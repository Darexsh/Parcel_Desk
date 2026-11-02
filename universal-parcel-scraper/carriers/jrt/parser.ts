import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { mainZone } from '../../places/zones.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isJrtDhlGermanRow, isJrtDhlRow, isJrtUpsRow, jrtEnglish, jrtStage } from './status.js';

export const PROVIDER = 'JRT';
export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe or FedEx's on the line to Ireland, whose product names FedEx, and JRT's
// own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) || isJrtDhlRow(content, location) ? 'wall' : 'platform'),
  ownNumber: /^JRT\d{10}[A-Z]{2}$/, unlabelledPartners: ['dhl'], productPartners: [[/\bFEDEX\b/i, 'fedex']],
};

// DHL's clock in Germany, where its rows on the line into Europe start.
const DHL_ZONE = 'Europe/Berlin';

/**
 * The result with DHL's rows the tracker copies without a place dated, each
 * keeping its wall clock: DHL's rows from Germany on DHL's German clock, the
 * others on the destination's, where DHL or its partner delivers, else on
 * DHL's. The newest row's instant, when it has one, is the last update.
 */
export function dateJrtDhlRows(result: CarrierResult): CarrierResult {
  const destination = /^[A-Z]{2}$/.test(result.destination_country ?? '') ? mainZone(result.destination_country!) : null;
  const events = result.events?.map((event): CarrierEvent => {
    const description = event.description ?? '';
    if (event.time || !event.local_time || !isJrtDhlRow(description, event.location ?? '')) return event;
    const [zone, basis] = isJrtDhlGermanRow(description) || !destination ? [DHL_ZONE, 'carrier'] : [destination, 'destination'];
    const time = firstOccurrence(DateTime.fromISO(event.local_time, { zone })).toISO({ suppressMilliseconds: true });
    return time ? { ...event, time, time_zone: zone, time_zone_basis: basis } : event;
  });
  if (!events) return result;
  const newest = events[0];
  const { last_update_local: local, ...rest } = result;
  return { ...rest, last_update: newest?.time ?? result.last_update, ...(newest?.time || !local ? {} : { last_update_local: local }), events };
}

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && dateJrtDhlRows(result);
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateJrtDhlRows(parseHualeiPage(html, number, JRT, readAt));
