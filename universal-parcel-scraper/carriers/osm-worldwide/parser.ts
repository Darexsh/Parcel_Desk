import { normalizeTrackingNumber, uspsPackageIdentifier } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { osmStage } from './status.js';

export const PROVIDER = 'OSM Worldwide';
// A parcel's reply is a few kilobytes: a dozen short scans.
export const OSM_MAX_BYTES = 512 * 1024;

// The tracker takes any letters and digits: OSM's own package ids and the
// partner numbers it labels parcels with, most of them USPS barcodes.
const NUMBER = /^[A-Z0-9]{4,40}$/;
// A scan's clock as the service sends it, a wall time without an offset.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// An expected day, alone or at midnight.
const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0{1,7})?)?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The page shows no estimate once the parcel is delivered or after a failed attempt.
const NO_ESTIMATE: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'failed_attempt']);

/**
 * A number as the tracker looks it up. A USPS routing barcode opens with the
 * recipient's ZIP code, so only the package identifier after it is sent; one
 * without a clean identifier is refused.
 */
export function normalizeOsmNumber(raw: string): string {
  const compact = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const number = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'OSM Worldwide tracks four to forty letters and digits');
  return number;
}

/** Whether the number is a whole USPS package barcode, which USPS delivers. */
export function isUspsNumber(number: string): boolean {
  return uspsPackageIdentifier(number) === number;
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `OSM Worldwide returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** An optional flag: absent is false, anything but a boolean is a changed reply. */
function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new SchemaError(PROVIDER, `OSM Worldwide returned an invalid ${key}`);
  return value;
}

/** A scan's clock: an instant when it carries an offset, else its wall time. */
function clockOf(value: string): { time: string } | { local_time: string } | null {
  const instant = explicitOffsetTime(value);
  if (instant) return { time: instant.iso };
  const match = WALL_CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // Only the calendar fields are checked; no offset is assigned. Luxon accepts hour 24.
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return { local_time: `${year}-${month}-${day}T${hour}:${minute}:${second}` };
}

/** The scan's town, state and country. A part holding a digit could be a street or a postcode, so it is left out. */
function placeOf(row: Record<string, unknown>): string {
  return ['city', 'state', 'country'].map((key) => text(row, key, 100))
    .filter((part) => part && !/\d/.test(part)).join(', ');
}

/**
 * One scan: its clock, wording, code, place and the tracker's flags. The
 * postcode, the place line built with it and the scan's id, which the page
 * sends back with delivery instructions, are never read.
 */
function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'OSM Worldwide returned an invalid scan');
  const description = text(row, 'description');
  const clock = clockOf(text(row, 'datetime', 40));
  if (!description || !clock) throw new SchemaError(PROVIDER, 'OSM Worldwide returned a scan without its wording or clock');
  const code = text(row, 'eventCode', 16);
  const group = row.group === undefined || row.group === null ? 0 : row.group;
  if (typeof group !== 'number' || !Number.isInteger(group)) throw new SchemaError(PROVIDER, 'OSM Worldwide returned an invalid group');
  const location = placeOf(row);
  const staged = osmStage(code, description, { group, instructionsNeeded: flag(row, 'instructionsNeeded'), isException: flag(row, 'isException') });
  return { ...clock, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** The expected day the page shows, while the parcel is still to be delivered. */
function expectedDay(value: string, stage: Stage | undefined): string | null {
  const match = DAY.exec(value);
  if (!match || (stage && NO_ESTIMATE.has(stage))) return null;
  return calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * The reply of `GET /tracking/tracking-request?ids={number}`: one entry per
 * number asked for, here one. The entry names the number it answers, upper
 * case, and is `found` with the parcel's scans newest first, or `not-found`.
 * The customer package id beside it is the shipper's reference and is never
 * read. A USPS package barcode is a parcel USPS delivers, so the result names
 * USPS as the delivery partner, which tracks it under the same number.
 */
export function parseOsmWorldwide(payload: unknown, raw: string): CarrierResult {
  const number = normalizeOsmNumber(raw);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(PROVIDER, 'OSM Worldwide returned an unexpected reply');
  }
  const entry = payload[0];
  if (text(entry, 'id', 64).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'OSM Worldwide answered for another number');
  const result = text(entry, 'result', 32);
  if (result === 'not-found') throw new NotFoundError(PROVIDER);
  if (result !== 'found') throw new IndeterminateError(PROVIDER, 'OSM Worldwide returned an unknown lookup result');
  const rows = entry.history ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'OSM Worldwide returned an invalid parcel history');

  // The reply lists scans newest first. Their clocks have no offset and come
  // from several places, so its order stands; identical rows are kept once.
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = scanOf(row);
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expectedDay(text(entry, 'estDelivery', 40), stage),
    ...(isUspsNumber(number) ? { delivery_carrier: 'usps' } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

