import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gofoStatus } from './status.js';

const LABEL_CREATED = '100';
/** The clock the adapter requests from GOFO US: GOFO prints Pacific clocks with their real offset. */
export const GOFO_CLOCK_ZONE = 'America/Los_Angeles';
// GOFO appends its support phone and email to some scans, in English or
// Spanish; the public page removes that line before display.
const CONTACT = String.raw`(?:\+?\(?\d[\d ().-]*\d|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)`;
const SUPPORT_LINE = new RegExp(String.raw`\s*(?:For delivery issues (?:&|and) tracking support, contact GOFO at|Para problemas de entrega y soporte de seguimiento, comun[ií]quese con GOFO al) ${CONTACT}(?:,? (?:or|and|o|y) ${CONTACT})*\.?$`, 'iu');

/** GOFO US waybills: GFUS numbers, and the older GF and CR series its tracker still serves. */
const WAYBILL = /^(?:GFUS\d{14}|GF\d{13}|CR\d{12})$/;
/** GOFO Canada waybills. */
const CANADA_WAYBILL = /^GFCA\d{14}$/;
/**
 * GOFO files some parcels under a GFUS waybill with a CR tracking number.
 * Asked for either, it returns that one parcel.
 */
const PAIRED_WAYBILL = /^GFUS\d{14}$/;
const PAIRED_REFERENCE = /^CR\d{12}$/;
/** YunExpress numbers GOFO delivers under the same number, as both waybill and tracking number. */
const YUNEXPRESS = /^YT\d{16}$/;

/**
 * A national GOFO site that runs the US consignee service: its gofo.com path,
 * which also keys its error list, the numbers it tracks and the zone whose
 * clocks the adapter requests.
 */
export interface GofoSite {
  readonly carrier: 'gofo' | 'gofo-ca';
  readonly provider: string;
  readonly path: 'us' | 'ca';
  readonly numbers: RegExp;
  readonly requirement: string;
  readonly clockZone: string;
  /** GOFO's `toCountry` for the site's own country. */
  readonly toCountry: string;
  readonly country: string;
}

export const GOFO_US: GofoSite = { carrier: 'gofo', provider: 'GOFO', path: 'us', numbers: new RegExp(`${WAYBILL.source}|${YUNEXPRESS.source}`),
  requirement: 'GOFO US requires a GOFO waybill (GFUS and 14 digits, GF and 13, or CR and 12) or a YunExpress number it delivers',
  clockZone: GOFO_CLOCK_ZONE, toCountry: 'USA', country: 'US' };
export const GOFO_CANADA: GofoSite = { carrier: 'gofo-ca', provider: 'GOFO CA', path: 'ca', numbers: CANADA_WAYBILL,
  requirement: 'GOFO Canada requires a GFCA waybill and 14 digits', clockZone: 'America/Toronto', toCountry: 'CA', country: 'CA' };

export function normalizeGofoNumber(raw: string, site: GofoSite = GOFO_US): string {
  const number = normalizeTrackingNumber(raw);
  if (!site.numbers.test(number)) throw new InvalidInputError(site.provider, site.requirement);
  return number;
}

function scanClock(value: unknown, scanZone: unknown, site: GofoSite): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  const raw = clean(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?)(Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?$/.exec(raw);
  if (!match) {
    // Offset-looking values must not exploit a permissive ISO parser.
    if (raw.includes('T') && /(?:Z|[+-][\d:]+)$/i.test(raw)) throw new SchemaError(site.provider, 'GOFO returned an invalid scan timestamp');
    return raw ? { provider_time_text: raw } : {};
  }
  const local = DateTime.fromISO(match[1]!, { zone: 'UTC' });
  if (!local.isValid) throw new SchemaError(site.provider, 'GOFO returned an invalid scan date');
  if (!match[2]) return { local_time: local.toISO({ includeOffset: false, suppressMilliseconds: true }) };
  const offset = match[2].replace(':', '');
  if (offset !== 'Z' && Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3)) > 840) throw new SchemaError(site.provider, 'GOFO returned an invalid scan offset');
  const time = explicitOffsetTime(raw);
  if (!time) throw new SchemaError(site.provider, 'GOFO returned an invalid scan timestamp');
  // GOFO's "Local Time" setting pairs each scan's local clock with the site
  // zone's offset. A requested clock must carry its zone's offset at that time;
  // the instant is then expressed in the scan's own zone when it has a valid one.
  const instant = DateTime.fromMillis(time.timestamp, { zone: site.clockZone });
  if (instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== match[1]!.slice(0, 19)) throw new SchemaError(site.provider, 'GOFO returned a clock outside the requested zone');
  const zone = clean(scanZone, 64);
  return { time: (IANAZone.isValidZone(zone) ? instant.setZone(zone) : instant).toISO({ suppressMilliseconds: true })! };
}

/** Scan wording without a trailing support line; a scan worded only by that line keeps it. */
function scanText(value: unknown): string {
  const text = clean(value, 1_000);
  return (text.replace(SUPPORT_LINE, '') || text).slice(0, 500);
}

export function parseGofo(payload: unknown, rawNumber: string, site: GofoSite = GOFO_US): CarrierResult {
  const number = normalizeGofoNumber(rawNumber, site);
  if (!isRecord(payload)) throw new SchemaError(site.provider);
  if (payload.code !== 200 || payload.success !== 1) throw new IndeterminateError(site.provider, 'GOFO returned an inconclusive lookup');
  if (!isRecord(payload.data) || !Array.isArray(payload.data.success) || payload.data.success.length > 25
    || !payload.data.success.every(isRecord) || !isRecord(payload.data.error)) throw new SchemaError(site.provider);
  const entries = payload.data.success;
  const error = payload.data.error;
  const own = error[site.path];
  if (!entries.length && error.errorCount === 1 && Array.isArray(own) && own.length === 1 && own[0] === number
    && Object.keys(error).every(key => ['errorCount', site.path].includes(key))) throw new NotFoundError(site.provider);
  if (!entries.length) throw new IndeterminateError(site.provider, 'GOFO returned no matching history');
  // The requested number is the waybill, or the CR tracking number of its
  // GFUS waybill. Otherwise the tracking number repeats the waybill or is the
  // shipper's own reference, which must not name another GOFO parcel.
  const waybill = entries[0]!.waybillNo;
  const reference = entries[0]!.trackingNumber;
  const paired = typeof waybill === 'string' && PAIRED_WAYBILL.test(waybill)
    && typeof reference === 'string' && PAIRED_REFERENCE.test(reference);
  const ownReference = reference === number || paired || (!YUNEXPRESS.test(number) && typeof reference === 'string' && clean(reference, 100) !== ''
    && ![WAYBILL, CANADA_WAYBILL].some(pattern => pattern.test(normalizeTrackingNumber(reference))));
  const requested = waybill === number || (paired && reference === number);
  if (entries.length !== 1 || !requested || !ownReference || error.errorCount !== 0) {
    throw new SchemaError(site.provider, 'GOFO returned a different or ambiguous parcel');
  }
  const item = entries[0]!;
  if (!Array.isArray(item.trackEventList) || item.trackEventList.length > 500 || !item.trackEventList.every(isRecord)) throw new SchemaError(site.provider);
  if (!item.trackEventList.length) throw new IndeterminateError(site.provider, 'GOFO returned no parcel scans');
  // The public client renders this entire list without paging and ignores the
  // counter, which can also count scans the list omits. A larger counter is
  // accepted only while the list still reaches label creation; the summary
  // check below binds its newest end.
  if (!Number.isInteger(item.trackEventCount) || Number(item.trackEventCount) < item.trackEventList.length
    || Number(item.trackEventCount) > 500) {
    throw new IndeterminateError(site.provider, 'GOFO returned an inconsistent parcel event count');
  }
  if (Number(item.trackEventCount) > item.trackEventList.length && clean(item.trackEventList.at(-1)!.processCode, 32) !== LABEL_CREATED) {
    throw new IndeterminateError(site.provider, 'GOFO returned incomplete parcel history');
  }
  const first = item.trackEventList[0]!;
  const summary = item.lastTrackEvent;
  if (!isRecord(summary) || ['processDate', 'processCode', 'processContent', 'processCity', 'processProvince', 'processLocation', 'processDeptId', 'processSecondCode', 'processTimeZone', 'processTimeZoneMapping'].some(key => summary[key] !== first[key])) {
    throw new IndeterminateError(site.provider, 'GOFO latest summary does not match its first scan');
  }
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of item.trackEventList) {
    const code = clean(row.processCode, 32);
    const rawDescription = scanText(row.processContent);
    if (!code || !rawDescription) throw new SchemaError(site.provider, 'GOFO returned an incomplete scan');
    const mapped = gofoStatus(code, rawDescription);
    if (mapped?.stage === 'delivered' && !/^Delivered(?:,|$)/.test(rawDescription)) throw new IndeterminateError(site.provider, 'GOFO returned inconsistent delivery evidence');
    if ((row.waybillNo != null && row.waybillNo !== waybill) || (row.trackingNumber != null && row.trackingNumber !== reference)) {
      throw new SchemaError(site.provider, 'GOFO returned a scan for a different parcel');
    }
    const timestamp = scanClock(row.processDate, row.processTimeZone, site);
    const location = [clean(row.processCity, 100), clean(row.processProvince, 20)].filter(Boolean).join(', ');
    const description = mapped?.stage === 'delivered' ? 'Delivered' : rawDescription;
    const event: CarrierEvent = { ...timestamp, description, provider_code: code,
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  const current = gofoStatus(String(latest.provider_code), latest.description);
  const service = clean(item.serviceName, 80);
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null,
    ...(current?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(item.toCountry === site.toCountry ? { destination_country: site.country } : {}), ...(service ? { service_name: service } : {}),
    events: events.slice(0, 100) };
}
