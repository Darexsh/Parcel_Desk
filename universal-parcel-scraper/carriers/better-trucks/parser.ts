import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { betterTrucksStage, isHubScan } from './status.js';

export const PROVIDER = 'Better Trucks';
// A history of a dozen scans is about ten kilobytes; its delivery photo links are most of it.
export const BETTER_TRUCKS_MAX_BYTES = 512 * 1024;
// Letters, digits and underscores with at least one digit, as BTPA… and BTS_… numbers are written.
const NUMBER = /^(?=[A-Z_]*\d)[A-Z0-9_]{10,40}$/;
// The tracker's package codes: five characters from a 32-symbol alphabet, or
// BTS and a code without the underscore. The page swaps them for the tracking
// number they stand for, which lets a made-up code open a stranger's parcel.
const PACKAGE_CODE = /^(?:[2-9A-HJ-NP-Z]{5}|BTS[^_].*)$/;
// A scan's clock as the reply writes it: to the second, without an offset; one with an offset is read in it.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/;
// The zone the reply gives a scan's local reading, as GMT-05:00.
const GMT_OFFSET = /^GMT([+-])(\d{2}):(\d{2})$/;
// Rows the page leaves out of its history: a duplicate of the label's
// creation and a failure inside the dispatch system.
const HIDDEN = new Set(['TRANSACTION_CREATED', 'ONFLEET_FAILED']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Better Trucks' tracker, in upper case; anything else, package codes included, is not one it is asked. */
export function normalizeBetterTrucksNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (PACKAGE_CODE.test(number)) throw new InvalidInputError(PROVIDER, 'Better Trucks package codes are not tracking numbers');
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Better Trucks numbers are ten or more letters, digits and underscores');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Better Trucks returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`Better Trucks returned an invalid ${key}`);
  return value;
}

/** A clock as an instant in UTC, its digits read as UTC without an offset; null when it is not a clock. Date libraries accept hour 24, so the fields are checked here. */
function utcClock(value: string): DateTime | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, date, hour, minute, second] = match;
  if (!calendarDay(Number(year), Number(month), Number(date)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  return parsed.isValid ? parsed.startOf('second') : null;
}

/**
 * The offset of the scan's local reading in `relative_time`, in minutes, when
 * that reading is the same instant as `object_created`; else null.
 */
function localOffset(row: Record<string, unknown>, utc: DateTime): number | null {
  const readings = row.relative_time;
  if (readings === null || readings === undefined) return null;
  if (!Array.isArray(readings)) invalid('Better Trucks returned an invalid relative_time');
  const local: unknown = (readings as unknown[]).find((reading) => isRecord(reading) && reading.name === 'LOCAL_TIME');
  if (!isRecord(local) || typeof local.time !== 'string' || typeof local.timezone !== 'string') return null;
  const zone = GMT_OFFSET.exec(local.timezone.trim());
  const wall = utcClock(local.time.trim());
  if (!zone || !wall || Number(zone[2]) > 14 || Number(zone[3]) > 59) return null;
  const offset = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  return wall.toMillis() - offset * 60_000 === utc.toMillis() ? offset : null;
}

/**
 * A scan's instant. `object_created` is UTC without its offset: the page reads
 * it as UTC, and `relative_time` labels the same digits Greenwich Mean Time.
 * The instant is written in the offset of the scan's local reading when that
 * reading agrees with it. The reply gives GMT+00:00 there when it has no
 * position for the scan, which names no US clock, so that scan stays in UTC.
 */
function scanTime(row: Record<string, unknown>): string {
  const utc = utcClock(text(row, 'object_created', 40));
  if (!utc) invalid('Better Trucks returned an invalid scan time');
  const offset = localOffset(row, utc);
  const shown = offset ? utc.setZone(FixedOffsetZone.instance(offset)) : utc;
  return shown.toISO({ suppressMilliseconds: true })!;
}

/** A scan's place: its town and state, and its country outside the US. */
function placeOf(row: Record<string, unknown>): string {
  const place = record(row, 'location');
  const town = text(place, 'city', 80);
  const state = text(place, 'state', 40);
  const country = text(place, 'country', 40);
  const parts = [town, state, country && country.toUpperCase() !== 'US' ? country : ''].filter(Boolean);
  return parts.join(', ');
}

/** The wording the page shows for a scan: the reply's own, or the page's label for a code it is given as. */
function wordingOf(code: string, details: string): string {
  if (details.toUpperCase() === 'RTS_RETURNED_TO_STATION') return 'Return To Station';
  return details || code.toLowerCase().split('_').join(' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

/**
 * One history row: its `status` code, `status_details`, clock and place. Its
 * `event_details` (who took the parcel, where it was left, why a delivery
 * failed), `images` (delivery photos) and `location_info` are not read. Only a
 * hub scan keeps its coordinates: the others can be the shipper's or the
 * recipient's door.
 */
function projectRow(row: Record<string, unknown>): CarrierEvent | null {
  const code = text(row, 'status', 80).toUpperCase();
  if (!code) invalid('Better Trucks returned a scan without its status');
  if (HIDDEN.has(code)) return null;
  const description = wordingOf(code, text(row, 'status_details', 200));
  const time = scanTime(row);
  const location = placeOf(row);
  const point = location && isHubScan(code) ? eventPoint(row.latitude, row.longitude) : null;
  const staged = betterTrucksStage(code, description);
  return {
    time, ...(location ? { location } : {}), ...(point ? { point } : {}), description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The scan that sets the status: the newest with a stage. A corrected address
 * ends the wait for its confirmation, so the wait before it no longer counts,
 * as the page shows the scan before both instead.
 */
function statusScan(events: readonly CarrierEvent[]): CarrierEvent | undefined {
  let corrected = false;
  for (const event of events) {
    if (event.provider_code === 'ADDRESS_CORRECTED') corrected = true;
    else if (event.stage && !(corrected && event.provider_code === 'AWAITING_ADDRESS_CONFIRMATION')) return event;
  }
  return undefined;
}

/**
 * The reply of the tracker's `/api/tracking/{number}`. A number it does not
 * know is HTTP 200 with the status `UNKNOWN` ("Invalid tracking no") and an
 * empty history, which the page shows as "Shipment can't be found". The reply
 * must name the number asked.
 */
export function parseBetterTrucks(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBetterTrucksNumber(raw);
  if (!isRecord(payload) || typeof payload.tracking_number !== 'string' || !Array.isArray(payload.tracking_history)) {
    invalid('Better Trucks returned an invalid tracking reply');
  }
  if (normalizeTrackingNumber(clean(payload.tracking_number, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Better Trucks answered for another parcel');
  }
  const rows: unknown[] = payload.tracking_history;
  if (rows.length > MAX_ROWS) invalid('Better Trucks returned an oversized history');
  if (!rows.length) {
    if (text(record(payload, 'tracking_status'), 'status', 40).toUpperCase() === 'UNKNOWN') throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER);
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) invalid('Better Trucks returned an invalid scan');
    const event = projectRow(row);
    if (!event) continue;
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Every scan is an instant; newest first by the clock, the order stays stable.
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const newest = events[0]!;
  const scan = statusScan(events);
  const stage = scan?.stage as Stage | undefined;
  const country = text(record(payload, 'address_to'), 'country', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scan!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage === 'delivered' ? { delivered_at: scan!.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
