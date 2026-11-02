import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, firstOccurrence, sharedClockZone } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { citylinkStage } from './status.js';

export const PROVIDER = 'City-Link Express';
// A long history is a few kilobytes.
export const CITYLINK_MAX_BYTES = 256 * 1024;
// The tracker asks for the fifteen digits of the consignment note.
const NUMBER = /^\d{15}$/;
// City-Link's own clock: its system and its Malaysian branches keep Malaysia's.
const ZONE = 'Asia/Kuala_Lumpur';
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^(\d{2})(\d{2})(\d{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A City-Link consignment number; anything else is not one City-Link issues. */
export function normalizeCitylinkNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'City-Link consignment numbers are fifteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `City-Link returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The courier a scan names after its label: "With City-Link delivery courier: …".
const COURIER = /\b(courier|rider|driver)\s*:[\s\S]*$/i;
// Who took the parcel, after the scan's own words: "Package Delivered - Signed for by: …".
const RECEIVER = /\s*[,;:\-–(]?\s*\b(signed for by|received by|collected by|delivered to)\b\s*:?\s*\S[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/**
 * A scan's wording as the page shows it, without the `SR - ` the page drops,
 * the courier or the person who signed, or phone numbers.
 */
export function citylinkWording(raw: string): string {
  let own = clean(raw).replace(/\bSR - /g, '').replace(COURIER, '$1').replace(PHONE, '');
  const receiver = RECEIVER.exec(own);
  // A wording that is only the label keeps it.
  if (receiver) own = own.slice(0, receiver.index).trim() || receiver[1]!;
  return clean(own).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's `detDate` (`DD/MM/YYYY`) and `detTime` (`HHmmss`) as an offset-less wall clock. */
function wallClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'detDate', 16));
  const clock = CLOCK.exec(text(row, 'detTime', 16));
  const wall = date && clock ? `${date[3]}-${date[2]}-${date[1]}T${clock[1]}:${clock[2]}:${clock[3]}` : '';
  // Parsing in UTC checks the calendar digits only. Luxon rolls 24:00:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!wall || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'City-Link returned an invalid scan time');
  }
  return wall;
}

/**
 * A scan's instant, when its place settles the clock: the country after the
 * location's last comma keeps Malaysia's clock at that moment, so the reading
 * is the same whether the branch or City-Link's system stamped it. Malaysia,
 * Singapore and Brunei do; elsewhere, or without a location, the wall clock
 * stays local.
 */
function scanInstant(wall: string, location: string): string | null {
  const comma = location.lastIndexOf(',');
  const zone = comma < 0 ? null : countryTimeZone(location.slice(comma + 1).trim());
  const shared = zone ? sharedClockZone([ZONE, zone], wall) : null;
  return shared ? firstOccurrence(DateTime.fromISO(wall, { zone: shared })).toISO({ suppressMilliseconds: true }) : null;
}

/** A scan's code: `CP_Code`, with its `DisposeCode` after a colon when it has one, as `SP:60`. */
export function citylinkCode(row: Record<string, unknown>): string {
  const code = cleanScalar(row.CP_Code, 16).toUpperCase();
  const disposal = cleanScalar(row.DisposeCode, 16).toUpperCase();
  return code && disposal ? `${code}:${disposal}` : code;
}

function projectRow(row: Record<string, unknown>): { key: string; wall: string; event: CarrierEvent } {
  const description = citylinkWording(text(row, 'status', 500));
  if (!description) throw new SchemaError(PROVIDER, 'City-Link returned a scan without wording');
  const wall = wallClock(row);
  const location = text(row, 'location', 120);
  const time = scanInstant(wall, location);
  const code = citylinkCode(row);
  const staged = citylinkStage(code, description);
  const event: CarrierEvent = {
    ...(time ? { time } : { local_time: wall }),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([wall, code, description, location]), wall, event };
}

/** The weight in kilograms the reply gives as a decimal string; none when it is missing or zero. */
function weight(data: Record<string, unknown>): number | null {
  const value = cleanScalar(data.weight, 16);
  const kilograms = /^\d{1,5}(?:\.\d{1,3})?$/.test(value) ? Number(value) : 0;
  return kilograms > 0 ? kilograms : null;
}

/** Whether a reply is the tracker's own answer for a number it has no record of. */
export function isCitylinkNotFound(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.error === 'string' && /^no tracking data found\.?$/i.test(payload.error.trim());
}

/**
 * The reply of the tracking page's `/wp-json/wp/v2/getTracking` for one
 * number: City-Link's answer in `req.data`, its scans oldest first. A number it
 * has no record of is an HTTP 404 instead (see `isCitylinkNotFound`). The
 * shipment must name the number asked. Only its number, weight and scans are
 * read.
 */
export function parseCitylink(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCitylinkNumber(raw);
  const request = isRecord(payload) ? payload.req : undefined;
  if (!isRecord(request) || !Object.hasOwn(request, 'data')) throw new SchemaError(PROVIDER, 'City-Link returned an invalid envelope');
  if (request.status !== undefined && request.status !== 200) throw new IndeterminateError(PROVIDER, 'City-Link did not complete the lookup');
  const data = request.data;
  if (!isRecord(data) || typeof data.returncode !== 'string') throw new SchemaError(PROVIDER, 'City-Link returned a reply without its result code');
  // The page reports any other code as no details found; the tracker's own
  // answer for an unknown number is the 404, so another code is inconclusive.
  if (data.returncode !== '00') throw new IndeterminateError(PROVIDER, 'City-Link did not complete the lookup');
  if (typeof data.trackingNo !== 'string') throw new SchemaError(PROVIDER, 'City-Link returned a shipment without its number');
  if (normalizeTrackingNumber(clean(data.trackingNo, 64)) !== number) throw new IndeterminateError(PROVIDER, 'City-Link answered for another shipment');
  const rows = data.trackDetails;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'City-Link returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'City-Link returned an oversized history');

  const seen = new Set<string>();
  const scans: ReturnType<typeof projectRow>[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'City-Link returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; it turns the reply's order round.
  if (scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? current!.time : undefined;
  const kilograms = weight(data);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
