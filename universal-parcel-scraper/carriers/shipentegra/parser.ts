import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber, uspsPackageIdentifier } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shipentegraStage, shipentegraSummaryStage } from './status.js';

export const PROVIDER = 'ShipEntegra';
// A long history is a few kilobytes.
export const SHIPENTEGRA_MAX_BYTES = 256 * 1024;
// A ShipEntegra number: the nine-digit label number, with or without 1SE.
const NUMBER = /^(?:1SE)?(\d{9})$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * The nine digits the tracker looks a number up by. Its lookup refuses the 1SE
 * prefix, and every other shape is a number ShipEntegra does not issue.
 */
export function normalizeShipentegraNumber(raw: string): string {
  const digits = raw.length <= 64 ? NUMBER.exec(normalizeTrackingNumber(raw).toUpperCase())?.[1] : undefined;
  if (!digits) throw new InvalidInputError(PROVIDER, 'ShipEntegra numbers are 1SE and nine digits');
  return digits;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `ShipEntegra returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens between
// them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A clause naming who took or signed for the parcel, in a partner's words after the sentence.
const RECEIVER = /\s*\b(?:signed|signature|received by|picked up by|collected by|left with|delivered to|teslim alan|imza)[\s\S]*$/i;

/**
 * A scan's wording, as the page shows it, without a clause naming who took
 * the parcel and without phone numbers.
 */
export function shipentegraWording(event: string): string {
  return clean(event.replace(RECEIVER, '').replace(PHONE, '')).replace(/\s+([,;:.])/g, '$1').replace(/[\s,;:\-–(]+$/, '');
}

/**
 * A scan's clock, `2026-01-02 15:04`: a wall clock with no zone. ShipEntegra's
 * own scans and its partners' abroad share the field, so it stays local.
 */
function scanClock(value: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}:00` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'ShipEntegra returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = shipentegraWording(text(row, 'event'));
  if (!description) throw new SchemaError(PROVIDER, 'ShipEntegra returned a scan without wording');
  const local = scanClock(text(row, 'date', 32));
  const staged = shipentegraStage(description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description]), event };
}

/**
 * The partners the page links a last-mile number to, by the tracker's own
 * name for them, whose links open that carrier's tracker. Widect's tracker
 * takes the delivering carrier's number, which the reply does not name, and
 * the catalog does not know DirectLink or Yodel; `SE` is ShipEntegra itself.
 */
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['dhl', 'dhl-express'],
  ['dhlecommerce', 'dhl-ecommerce'],
  ['fedex', 'fedex'],
  ['tnt', 'tnt'],
  ['ups', 'ups'],
  ['usps', 'usps'],
]);

/**
 * The carrier that takes the parcel on and its own number for it: a partner
 * the catalog knows, and a number that carrier's rules offer, without the
 * recipient's ZIP code a USPS routing barcode opens with.
 */
function handoff(payload: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const carrier = PARTNERS.get(text(payload, 'last_mile_carrier', 40).toLowerCase());
  const compact = normalizeTrackingNumber(cleanScalar(payload.last_mile_tracking_number, 64));
  const delivery = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!carrier || !/^[A-Z0-9]{4,40}$/.test(delivery) || delivery.endsWith(number)) return {};
  return (detectCarrierMatch(delivery).candidates as string[]).includes(carrier)
    ? { delivery_carrier: carrier, delivery_tracking_number: delivery } : {};
}

/**
 * The reply of the tracker's `track_service.php` for one number. The status
 * the page shows is `status_description`, else `realCarrierStatusDescription`;
 * `NOTFOUND` is a number it does not know, which it echoes as an integer
 * ("0" for nine zeros). A shipment must name the number asked. The seller's
 * account id, the summary's delivery date and the domestic carrier are not read.
 */
export function parseShipentegra(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShipentegraNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'ShipEntegra returned an invalid reply');
  // The lookup's refusal of a number shape it does not take: {"status":false,"message":"…"}.
  if (payload.status === false) throw new SchemaError(PROVIDER, 'ShipEntegra refused the number');
  const status = (text(payload, 'status_description', 40) || text(payload, 'realCarrierStatusDescription', 40)).toUpperCase();
  const echoed = cleanScalar(payload.tracking_number, 64).toUpperCase().replace(/^1SE/, '');
  const rows = payload.activities ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'ShipEntegra returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ShipEntegra returned an oversized history');
  if (status === 'NOTFOUND') {
    if (!/^\d{1,9}$/.test(echoed) || Number(echoed) !== Number(number)) throw new SchemaError(PROVIDER, 'ShipEntegra answered for another number');
    if (rows.length) throw new IndeterminateError(PROVIDER, 'ShipEntegra reported scans for a number it does not know');
    throw new NotFoundError(PROVIDER);
  }
  if (!echoed) throw new SchemaError(PROVIDER, 'ShipEntegra returned a shipment without its number');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'ShipEntegra answered for another shipment');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ShipEntegra returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  // The tracker's word decides a delivery, a return or an exception, and stands in for scans without a stage.
  const summary = shipentegraSummaryStage(status);
  const decisive = summary === 'delivered' || summary === 'returned' || summary === 'exception' || !scanned ? summary : undefined;
  const stage = (decisive ?? scanned?.stage) as Stage | undefined;
  const source = decisive && decisive !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const destination = text(payload, 'destination_country', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(countryCode(destination) === destination ? { destination_country: destination } : {}),
    ...handoff(payload, number),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
