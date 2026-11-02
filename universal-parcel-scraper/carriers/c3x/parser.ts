import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { c3xStage } from './status.js';

export const PROVIDER = 'C3X';
// A long history is a few kilobytes.
export const C3X_MAX_BYTES = 256 * 1024;
// C3X airwaybills are ten digits.
const NUMBER = /^\d{10}$/;
const DAY = /^[A-Za-z]+ (\d{1,2}) [A-Za-z]+ \d{4}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const CODE = /^[A-Z][A-Z0-9]{0,15}$/;
const MAX_SHIPMENTS = 10;
const MAX_ROWS = 300;

/** A C3X airwaybill, as the tracking page sends it; anything else is not one C3X issues. */
export function normalizeC3xNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'C3X airwaybills are ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `C3X returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/**
 * A scan's `ActivityDate` and `ActivityTime`, as "Friday 06  December  2024"
 * and "13:11". The reply names no zone, so the clock stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const day = text(row, 'ActivityDate', 48).replace(/\s+/g, ' ');
  const time = text(row, 'ActivityTime', 16);
  const match = DAY.exec(day);
  // Parsing in UTC checks the calendar and the weekday only; the wall clock keeps no offset.
  const parsed = DateTime.fromFormat(`${day} ${time}`, 'cccc d MMMM yyyy HH:mm', { zone: 'UTC', locale: 'en-US' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat('HH:mm') !== time || parsed.day !== Number(match[1])) {
    throw new SchemaError(PROVIDER, 'C3X returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * One scan. `Remarks` is its wording and `Status` its code; `DeliveredTo`,
 * the name of who took the parcel, is not read.
 */
function projectRow(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'C3X returned an invalid scan');
  const code = text(row, 'Status', 16);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'C3X returned an invalid scan code');
  const description = clean(text(row, 'Remarks').replace(PHONE, '')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  if (!description) throw new SchemaError(PROVIDER, 'C3X returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'Location', 120);
  const staged = c3xStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The country of a `Destination` such as "ABU DHABI-UNITED ARAB EMIRATES":
 * the longest end of it after a hyphen that names a country, else its last part.
 */
function destination(item: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const parts = text(item, 'Destination', 120).split('-').map((part) => part.trim());
  if (parts.length < 2) return {};
  for (let index = 1; index < parts.length; index += 1) {
    const code = countryCode(parts.slice(index).join('-'));
    if (code) return { destination_country: code };
  }
  const name = parts.at(-1)!;
  return name ? { destination_country_name: name } : {};
}

/** The forwarding agent's number for the parcel, when it is one whole number other than C3X's. */
function forwarding(item: Record<string, unknown>, number: string): string {
  const raw = text(item, 'ForwardingNumber', 64).toUpperCase();
  return /^[A-Z0-9]{4,40}$/.test(raw) && raw !== number ? raw : '';
}

/**
 * The reply of the tracking page's `Tracking` lookup for one airwaybill:
 * `data.AirwayBillTrackList` holds an entry for each number asked, with its
 * scans newest first. An airwaybill C3X does not know comes back as its
 * number with every other field empty, which the page reports as not found.
 * The entry must be the number asked. Its proof-of-delivery images, shipper
 * reference, origin and weight are not read.
 */
export function parseC3x(payload: unknown, raw: string): CarrierResult {
  const number = normalizeC3xNumber(raw);
  if (!isRecord(payload) || typeof payload.statusCode !== 'number' || !isRecord(payload.data)) {
    throw new SchemaError(PROVIDER, 'C3X returned an invalid envelope');
  }
  const data = payload.data;
  if (payload.statusCode !== 200 || data.Code !== 1) throw new IndeterminateError(PROVIDER, 'C3X did not complete the lookup');
  const list = data.AirwayBillTrackList;
  if (!Array.isArray(list) || !list.length || list.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'C3X returned no result for the airwaybill');
  if (!list.every((item) => isRecord(item) && typeof item.AirWayBillNo === 'string')) {
    throw new SchemaError(PROVIDER, 'C3X returned a shipment without its airwaybill');
  }
  const item = (list as Record<string, unknown>[]).find((entry) => normalizeTrackingNumber(clean(entry.AirWayBillNo, 64)) === number);
  if (!item) throw new IndeterminateError(PROVIDER, 'C3X answered for another shipment');
  const rows = item.TrackingLogDetails ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'C3X returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'C3X returned an oversized history');
  if (!rows.length) {
    // The page's "This tracking number is not found": the number echoed with nothing else.
    const described = ['Origin', 'Destination', 'ShipperReference', 'ForwardingNumber', 'Weight']
      .some((key) => item[key] !== null && item[key] !== undefined && item[key] !== '');
    throw described ? new NoHistoryError(PROVIDER) : new NotFoundError(PROVIDER);
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  // The shipment's details can reach C3X after the parcel did: a later
  // "Shipment Information Received" does not take a moving parcel back.
  const current = newestFirst.find((event) => event.stage && event.stage !== 'registered') ?? newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const handoff = forwarding(item, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...destination(item),
    // The reply names no forwarding agent, so the hand-off goes by the number's own rules.
    ...(handoff ? { delivery_tracking_number: handoff } : {}),
    events: newestFirst,
  };
}
