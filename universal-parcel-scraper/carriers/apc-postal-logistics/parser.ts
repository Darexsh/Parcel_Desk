import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime, mislabeledWallTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { apcOwnScan, apcStage } from './status.js';

export const PROVIDER = 'APC Postal Logistics';
export const CARRIER = 'apc-postal-logistics';
// A long history is a few kilobytes.
export const APC_MAX_BYTES = 256 * 1024;
// The layouts of APC's own numbers: five digits, P and sixteen digits; five
// digits, A and nine or ten digits; or sixteen digits.
const NUMBER = /^(?:\d{5}P\d{16}|\d{5}A\d{9,10}|\d{16})$/;
const ISO_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UTC_LABEL = /(?:Z|[+-]00:00)$/;
const CODE = /^[0-9A-Z]{1,8}$/;
// A facility, town or country as the tracker names it: no digits, which a street or postcode would carry.
const PLACE = /^\p{L}[\p{L}\p{M} .,'’()&/-]{0,63}$/u;
// Scans that can happen at the recipient's address.
const AT_ADDRESS: readonly Stage[] = ['delivered', 'failed_attempt', 'returned'];
const FINAL: readonly Stage[] = ['delivered', 'returned'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An APC number as its tracker looks it up, upper case and without separators. */
export function normalizeApcNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'APC numbers are five digits, P or A and more digits, or sixteen digits');
  return number;
}

/** An identifier the reply names, normalized; an object or other non-text value is a changed reply. */
function identifier(parcel: Record<string, unknown>, key: string): string {
  const value = parcel[key];
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `APC returned an invalid ${key}`);
  return value.length <= 64 ? normalizeTrackingNumber(value) : '';
}

/**
 * The clock of a scan. APC stamps its own facility scans in UTC; it labels
 * the scans of airlines and delivery partners `+00:00` too, over their local
 * wall clock, so only that wall clock is kept. A scan with another offset
 * keeps it.
 */
function scanClock(value: unknown, code: string): { time: string } | { local_time: string } {
  const text = clean(value, 40);
  const parsed = ISO_CLOCK.test(text) ? explicitOffsetTime(text) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'APC returned an invalid scan time');
  if (apcOwnScan(code) || !UTC_LABEL.test(text)) return { time: parsed.iso };
  return { local_time: mislabeledWallTime(text)!.replace(/\.\d+$/, '') };
}

/**
 * The place of a scan. A label's place can be the sender's, and a delivery,
 * an attempt or a return can happen at the recipient's address, so theirs is
 * not kept; elsewhere only a name without digits is.
 */
function place(value: unknown, code: string, stage: Stage | undefined): string {
  if (code === 'DR' || (stage && AT_ADDRESS.includes(stage))) return '';
  const text = clean(value, 80);
  return PLACE.test(text) ? text : '';
}

function scan(row: unknown, partner: string | undefined): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'APC returned an invalid scan');
  const code = cleanScalar(row.code, 16).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'APC returned an invalid event code');
  let description = clean(row.description, 200);
  // The handoff notice names the partner's number with a placeholder the page fills in.
  if (description.includes('{TRACK_NUMBER}')) {
    description = clean(description.replaceAll('{TRACK_NUMBER}', partner ?? ''), 200).replace(/\s+([.,;:])/g, '$1');
  }
  if (!description) throw new SchemaError(PROVIDER, 'APC returned a scan without its description');
  const stage = code ? apcStage(code) : undefined;
  // An unknown code's wording still decides whether its place can be an address.
  const worded = stage ?? classifyWording(description).stage;
  const location = place(row.location, code, worded);
  return {
    ...scanClock(row.eventDateTimeISOFormat, code),
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(compact: string, own: readonly string[]): string | undefined {
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && !own.includes(code) ? code : undefined;
}

/** The country code that ends the recipient's address, which is otherwise not read. */
function destination(value: unknown): string | undefined {
  const code = / ([A-Z]{2})$/.exec(clean(value, 200))?.[1];
  return code && countryCode(code) === code ? code : undefined;
}

/** The calendar day of an estimate, in UTC as the page shows it. */
function estimatedDay(value: unknown): string | null {
  const text = clean(value, 40);
  const parsed = ISO_CLOCK.test(text) ? explicitOffsetTime(text) : null;
  return parsed ? new Date(parsed.timestamp).toISOString().slice(0, 10) : null;
}

/**
 * The reply of the lookup APC's tracker page makes,
 * `GET tracking.apc-pli.com/api/track?id={number}`: one parcel, its scans
 * newest first. The parcel names APC's number in `trackingReference2`; its
 * `packageNumber` is APC's number until a delivery partner takes over, then
 * the partner's number, which `carrierTrackingNumber` repeats. The tracker
 * also opens a parcel by the partner's number; such a reply is another
 * carrier's shipment. The recipient's address, the merchant's reference, the
 * partner's free text and the links are never read.
 */
export function parseApcPostalLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeApcNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.events)) throw new SchemaError(PROVIDER, 'APC returned a reply that is not a parcel');
  const own = identifier(payload, 'trackingReference2');
  const packageNumber = identifier(payload, 'packageNumber');
  const handedOver = identifier(payload, 'carrierTrackingNumber');
  if (own !== number && (packageNumber !== number || handedOver === number)) {
    if (packageNumber === number || handedOver === number) {
      throw new IndeterminateError(PROVIDER, 'APC found another shipment by its delivery partner\'s number');
    }
    throw new IndeterminateError(PROVIDER, 'APC answered for another parcel');
  }
  const rows = payload.events;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'APC returned an oversized history');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'APC has no scans for the parcel yet');
  const delivery = handedOver ? partnerNumber(handedOver, [number, own]) : undefined;

  // Partner clocks are not instants, so the reply's order, newest first, stands.
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = scan(row, delivery);
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  // The page shows the estimate until the parcel arrives.
  const settled = (stage && FINAL.includes(stage)) || payload.hasArrived === true;
  const from = settled ? null : estimatedDay(payload.estimatingDeliveryTimeFrom);
  const to = settled ? null : estimatedDay(payload.estimatingDeliveryTimeTo);
  const service = clean(payload.serviceName, 80);
  const country = destination(payload.shipToAddress);
  const partner = carrierIdFromPartner(clean(payload.finalMileCarrier, 64), clean(payload.externalTrackingUrl, 300));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    expected_delivery: to,
    ...(from && to && from < to ? { expected_delivery_from: from } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(partner && partner !== CARRIER ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
