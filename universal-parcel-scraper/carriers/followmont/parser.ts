import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { followmontStage, isFollowmontBookkeeping } from './status.js';

export const PROVIDER = 'Followmont';
export const CARRIER = 'followmont';
// Every item of a consignment has its own scans; a two-item delivery is under three kilobytes.
export const FOLLOWMONT_MAX_BYTES = 1024 * 1024;

// Seven or eight digits, as the pre-printed consignment notes carry, or the
// letters and digits the tracker's own check takes (its examples are a letter and six or seven digits).
const NUMBER = /^(?:\d{7,8}|[A-Z]{1,3}\d{6,10})$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The page's status for a consignment its freight system holds without an event yet.
const BOOKED = 'Shipment Info Received';
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_CONSIGNMENTS = 20;
const MAX_ROWS = 2_000;
const MAX_EVENTS = 100;

/** A Followmont connote number, in upper case as the tracker takes it; anything else is not one it issues. */
export function normalizeFollowmontNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Followmont connote numbers are seven or eight digits, or letters followed by digits');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Followmont returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Whether a field names the whole number asked, compared before any length cap. */
function names(value: unknown, number: string): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === number;
}

/** A list a reply leaves out, or sends empty, when it found nothing. */
function empty(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * A `YYYY-MM-DD HH:mm:ss` wall clock as `YYYY-MM-DDTHH:mm:ss`, with its
 * calendar checked; the system writes 30 December 1899 where it has no date.
 */
function wallClock(value: string): string | null | undefined {
  const match = CLOCK.exec(value);
  if (!match) return undefined;
  const wall = `${match[1]}T${match[2]}`;
  // Parsing in UTC checks the calendar digits only; the clock keeps no offset.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) return undefined;
  return wall < '2000-01-01' ? null : wall;
}

/** The estimate, a calendar day the reply writes as its last second. */
function estimate(consignment: Record<string, unknown>): string | null {
  return wallClock(text(consignment, 'ETA', 32))?.slice(0, 10) ?? null;
}

// A delivery address or a reference in place of a town.
const NOT_A_PLACE = /\d/;

interface Scan {
  wall: string;
  code: string;
  location: string;
  event: CarrierEvent;
}

/**
 * One item's event: the system's status code, which the reply writes in
 * camel case ("DepotIn"), the wall clock and the town. The code, split into
 * words, is the event's wording.
 */
function scanOf(row: unknown): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Followmont returned an invalid event');
  const status = text(row, 'EventStatus', 40);
  if (!status) throw new SchemaError(PROVIDER, 'Followmont returned an event without a status');
  const wall = wallClock(text(row, 'EventDate', 32));
  if (wall === undefined) throw new SchemaError(PROVIDER, 'Followmont returned an invalid event time');
  if (wall === null) return null;
  const code = status.toUpperCase();
  const description = status.replace(/([a-z])([A-Z])/g, '$1 $2');
  const place = text(row, 'EventLocation', 80);
  const location = NOT_A_PLACE.test(place) ? '' : place;
  const staged = followmontStage(code, description);
  return {
    wall, code, location,
    event: {
      local_time: wall,
      ...(location ? { location } : {}),
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** A consignment Followmont holds without an event, as the page shows it. */
function booked(expected: string | null): CarrierResult {
  return { status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map',
    last_status_text: BOOKED, last_update: null, expected_delivery: expected, summary_only: true, events: [] };
}

/**
 * The reply of the freight system's trace, `RETR_MISS_CONS_DATA___TM`, which
 * the Track & Trace page asks for a number its bookings search does not
 * find. A consignment comes in `Consignments` with each item's events, in no
 * order; `Status: "N"` with "Not Found" means the system holds none, and gives
 * `null` so the bookings can be asked.
 *
 * The consignment must name the whole number asked. Its addresses, sender,
 * receiver, account code, delivery-proof flags and handling notes are not read.
 */
export function parseFollowmontTrace(payload: unknown, raw: string): CarrierResult | null {
  const number = normalizeFollowmontNumber(raw);
  if (!isRecord(payload) || typeof payload.Status !== 'string') throw new SchemaError(PROVIDER, 'Followmont returned an invalid envelope');
  if (payload.Status === 'N') {
    if (payload.Description === 'Not Found' && empty(payload.Consignments)) return null;
    throw new IndeterminateError(PROVIDER, 'Followmont did not complete the lookup');
  }
  if (payload.Status !== 'S') throw new IndeterminateError(PROVIDER, 'Followmont did not complete the lookup');
  const consignments = payload.Consignments;
  if (!Array.isArray(consignments) || consignments.length > MAX_CONSIGNMENTS) {
    throw new SchemaError(PROVIDER, 'Followmont returned invalid consignments');
  }
  if (!consignments.length) throw new IndeterminateError(PROVIDER, 'Followmont answered without a consignment');
  if (!consignments.every(isRecord)) throw new SchemaError(PROVIDER, 'Followmont returned an invalid consignment');
  // The consignment number, where the reply repeats it, must agree.
  const own = consignments.filter((consignment) => names(consignment.ConId, number)
    && (consignment.ConsignmentNumber == null || names(consignment.ConsignmentNumber, number)));
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Followmont answered for another consignment');
  if (own.length > 1) throw new SchemaError(PROVIDER, 'Followmont returned the consignment more than once');
  const consignment = own[0]!;
  const rows = consignment.Events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Followmont returned a consignment with invalid events');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Followmont returned an oversized history');

  // Oldest first; each item is scanned on its own, so one kind of scan at
  // one place in the same minute is kept once, at its first clock.
  const scans = rows.map(scanOf).filter((scan): scan is Scan => scan !== null)
    .map((scan, index) => ({ scan, index }))
    .sort((a, b) => a.scan.wall.localeCompare(b.scan.wall) || a.index - b.index)
    .map(({ scan }) => scan);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const scan of scans) {
    const key = JSON.stringify([scan.wall.slice(0, 16), scan.code, scan.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.unshift(scan.event);
  }
  const expected = estimate(consignment);
  if (!events.length) return booked(expected);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // A consignment whose only events record it in the system is booked, as the page shows it.
  const recorded = !staged && events.every((event) => isFollowmontBookkeeping(event.provider_code as string));
  const stage = recorded ? 'registered' : staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: recorded ? 'carrier_map' : staged!.stage_source! } : {}),
    last_status_text: recorded ? BOOKED : newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: stage && FINAL.has(stage) ? null : expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the bookings search, `RETRI_CONSI_DATA___OEC`, for consignments
 * picked up in the window the page asks. It holds a consignment booked before
 * the freight system has it, which the page shows as "Shipment Info Received".
 * `Status: "N"` with "Consignment Not Found" is a missing consignment.
 *
 * The search also takes references, so a consignment must name the whole
 * number asked; the reply does not repeat a reference, so one it found for
 * one is inconclusive. Suburbs, zones and dates are not read.
 */
export function parseFollowmontBooking(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFollowmontNumber(raw);
  if (!isRecord(payload) || typeof payload.Status !== 'string') throw new SchemaError(PROVIDER, 'Followmont returned an invalid envelope');
  if (payload.Status === 'N') {
    if (payload.Description === 'Consignment Not Found' && empty(payload.items)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Followmont did not complete the search');
  }
  if (payload.Status !== 'S') throw new IndeterminateError(PROVIDER, 'Followmont did not complete the search');
  const items = payload.items;
  if (!Array.isArray(items) || items.length > MAX_CONSIGNMENTS || !items.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Followmont returned invalid bookings');
  }
  const own = items.filter((item) => names(item.ConnoteNumber_c, number)
    && (item.ConsignmentNumber_c == null || names(item.ConsignmentNumber_c, number)));
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Followmont answered for another consignment');
  return booked(null);
}

/** The pickup window the page asks the bookings search for: from a month ago to tomorrow, as UTC days. */
export function followmontBookingWindow(now: number): { FromDate: string; ToDate: string } {
  const today = DateTime.fromMillis(now, { zone: 'UTC' });
  return { FromDate: today.minus({ months: 1 }).toISODate()!, ToDate: today.plus({ days: 1 }).toISODate()! };
}
