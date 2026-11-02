import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import { HUALEI_ZONE, normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { mayiyinfuEnglish, mayiyinfuStage } from './status.js';

export const PROVIDER = 'Mayi Yinfu';
export const MAYIYINFU_ORIGIN = 'http://www.mayiyinfu.com.cn:8082';
// Rows keep their wall clocks; `dateMayiyinfuScans` dates those whose zone the
// record settles. Records name no channel; into Europe the transfer number is
// Deutsche Post DHL's, whose tracker follows the parcel to its delivery abroad.
// The forwarder's rows can give Shenzhen as "SZ", which as a code is Eswatini's: no place.
const splitMayiyinfuRow = (content: string, location: string) => ({ content, location: /^\s*SZ\s*$/i.test(location) ? '' : location });
export const MAYIYINFU: HualeiTenant = { carrier: 'mayiyinfu', provider: PROVIDER, origin: MAYIYINFU_ORIGIN, stage: mayiyinfuStage,
  english: mayiyinfuEnglish, split: splitMayiyinfuRow, wallClocks: true, unlabelledPartners: ['dhl'] };

// Mayi Yinfu's own rows carry Chinese; the rows it copies from DHL are English only.
const HAN = /\p{Script=Han}/u;

/**
 * The zone a row's wall clock keeps, where the record settles it. A row at a
 * place in China is on Beijing time, the place's clock and the tracker's
 * alike. Once DHL takes the record, a row copied from DHL whose place is a
 * country code is DHL's instant on the tracker's Beijing clock, wherever DHL
 * scanned it: DHL's own offset times for those scans are the same instants.
 * Null otherwise: DHL's rows without a place have also come on DHL's German
 * clock, and the forwarder's rows abroad could be on either clock.
 */
function scanZone(event: CarrierEvent, dhl: boolean): string | null {
  const place = event.location ?? '';
  const country = place ? countryCode(place) : null;
  if (country === 'CN') return HUALEI_ZONE;
  return dhl && country === place && !event.provider_code && !HAN.test(event.description ?? '') ? HUALEI_ZONE : null;
}

/**
 * The result with each row dated where its zone is settled; the others keep
 * their wall clocks. The newest row's instant, when it has one, is the last
 * update, and the delivery's when it is the newest row.
 */
export function dateMayiyinfuScans(result: CarrierResult): CarrierResult {
  const dhl = result.delivery_carrier === 'dhl';
  const events = result.events?.map((event): CarrierEvent => {
    const { local_time: wall, ...scan } = event;
    const zone = wall ? scanZone(event, dhl) : null;
    const time = zone ? isoTime(wall, zone)?.iso : undefined;
    return time ? { time, ...scan } : event;
  });
  const newest = events?.[0];
  const { last_update_local: local, ...rest } = result;
  return {
    ...rest,
    last_update: newest?.time ?? result.last_update,
    ...(newest?.time ? {} : local ? { last_update_local: local } : {}),
    ...(newest?.time && result.current_stage === 'delivered' && newest.stage === 'delivered' ? { delivered_at: newest.time } : {}),
    ...(events ? { events } : {}),
  };
}

export const normalizeMayiyinfuNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseMayiyinfuTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, MAYIYINFU, readAt);
  return result && dateMayiyinfuScans(result);
}
export const parseMayiyinfuPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateMayiyinfuScans(parseHualeiPage(html, number, MAYIYINFU, readAt));
