import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { logistiqStage } from './status.js';

export const PROVIDER = 'Logistiq';
// A long history is a few kilobytes.
export const LOGISTIQ_MAX_BYTES = 256 * 1024;
// Seven to nine letters, which vary by client and service, then nine digits, as on the public
// airwaybills. The tracker reads a lower-case waybill as unknown.
const NUMBER = /^[A-Z]{7,9}\d{9}$/;
// The tracker's answer for a waybill it does not know, which opens with the waybill asked.
const UNKNOWN = /^(\S+) is an invalid AWB\b/i;
// An instant with its offset, to the microsecond; the webhook documentation writes a space for the T.
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// A hub's code, such as LOGDXB. A pickup scan names the sender's address instead, and a return's
// pickup the customer's.
const HUB = /^[A-Za-z][A-Za-z0-9_-]{1,23}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill for Logistiq's tracker, in upper case; anything else is not one Logistiq issues. */
export function normalizeLogistiqNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Logistiq airwaybills are seven to nine letters and nine digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Logistiq returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional whole number, such as a status code; anything else is a changed reply. */
function count(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new SchemaError(PROVIDER, `Logistiq returned an invalid ${key}`);
}

// Who took the parcel, after a delivery's wording.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:received|collected|signed)\s+by\b[\s\S]*$/i;
// A part with a phone number (nine or more digits, with spaces, brackets, dots or hyphens
// between them, a date aside), an e-mail address, the recipient's code or a link, such as a
// proof of delivery.
const PRIVATE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])|\S@\S|\b(?:otp|pin)\b|\bcode\b\W*\d|https?:\/\//i;

/**
 * A scan's wording as the tracker shows it: `remarks`, then the parts of
 * `additional_remarks` that say something more, joined by ` | `, as
 * `Order Delivery Failed | Future Date Delivery | Not available`. Without
 * either, the status name. Who took the parcel is cut, and a part with a phone
 * number, an e-mail address, a code or a link is left out.
 */
export function logistiqWording(remarks: string, additional: string, status: string): string {
  const parts: string[] = [];
  for (const part of [remarks, ...additional.split('|')]) {
    if (PRIVATE.test(part)) continue;
    const line = clean(part.replace(RECEIVER, '')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
    // The tracker repeats the remark, or part of it, in the additional one.
    if (!line || parts.some((kept) => kept.toLowerCase().includes(line.toLowerCase()))) continue;
    parts.push(line);
  }
  if (parts.length) return parts.join(' | ');
  const name = clean(status.replace(/_/g, ' ')).toLowerCase();
  return name ? name[0]!.toUpperCase() + name.slice(1) : '';
}

/**
 * A scan's instant: `scan_time`, else `time_stamp`, the record's own, as the
 * tracker shows it. Both are UTC; the page shows them in the visitor's zone,
 * and the webhook documentation gives the same fields with `+00:00`.
 */
function scanTime(row: Record<string, unknown>): { iso: string; millis: number } {
  const raw = text(row, 'scan_time', 64) || text(row, 'time_stamp', 64);
  const parsed = DateTime.fromISO(raw.replace(' ', 'T'), { setZone: true });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!INSTANT.test(raw) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== raw.slice(0, 19).replace(' ', 'T')) {
    throw new SchemaError(PROVIDER, 'Logistiq returned an invalid scan time');
  }
  return { iso: parsed.startOf('second').toISO({ suppressMilliseconds: true }), millis: parsed.toMillis() };
}

interface Scan {
  key: string;
  event: CarrierEvent;
  millis: number;
  sequence: number;
}

function projectRow(row: Record<string, unknown>): Scan {
  const code = count(row, 'status_code');
  const provider = code === null ? '' : String(code);
  const description = logistiqWording(text(row, 'remarks'), text(row, 'additional_remarks', 500), text(row, 'status', 80));
  if (!description) throw new SchemaError(PROVIDER, 'Logistiq returned a scan without wording');
  const { iso, millis } = scanTime(row);
  const place = text(row, 'scan_location', 200);
  const location = HUB.test(place) ? place : '';
  const staged = logistiqStage(provider, description);
  const event: CarrierEvent = {
    time: iso,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([iso, provider, description, location]), event, millis, sequence: count(row, 'status_sequence') ?? 0 };
}

/** The country `destination_location` ends with, as in `Sample Town, AE`. */
function destinationCountry(data: Record<string, unknown>): string | null {
  const place = text(data, 'destination_location', 200);
  return place.includes(',') ? countryCode(place.slice(place.lastIndexOf(',') + 1)) : null;
}

/**
 * The reply of `robin.logistiq.io/v1/order-details` for one waybill, the
 * lookup Logistiq's tracking page makes. A waybill it does not know is HTTP
 * 400 with `status: false` and an `error_data` that names it invalid. A
 * shipment must name the waybill asked. Its scans and its current status,
 * which repeats the newest scan, make the history.
 */
export function parseLogistiq(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLogistiqNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'boolean') throw new SchemaError(PROVIDER, 'Logistiq returned an invalid envelope');
  if (!payload.status) {
    const unknown = UNKNOWN.exec(text(payload, 'error_data'));
    if (!unknown) throw new IndeterminateError(PROVIDER, 'Logistiq did not complete the lookup');
    if (unknown[1]!.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Logistiq answered for another waybill');
    throw new NotFoundError(PROVIDER);
  }
  const data = payload.data;
  if (!isRecord(data) || typeof data.waybill !== 'string') throw new SchemaError(PROVIDER, 'Logistiq returned a shipment without its waybill');
  if (clean(data.waybill, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Logistiq answered for another shipment');
  const listed = data.scans ?? [];
  if (!Array.isArray(listed)) throw new SchemaError(PROVIDER, 'Logistiq returned a shipment with invalid scans');
  const rows: unknown[] = listed;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Logistiq returned an oversized history');
  const current = data.current_status ?? null;
  if (current !== null && !isRecord(current)) throw new SchemaError(PROVIDER, 'Logistiq returned an invalid current status');

  const seen = new Set<string>();
  const scans: (Scan & { index: number })[] = [];
  for (const row of current ? [...rows, current] : rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Logistiq returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ ...scan, index: scans.length });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans at one instant keep the reply's sequence.
  const events = scans
    .sort((a, b) => b.millis - a.millis || b.sequence - a.sequence || b.index - a.index)
    .map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = destinationCountry(data);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
