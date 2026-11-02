import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { redxStage } from './status.js';

export const PROVIDER = 'RedX';
// A long history is under ten kilobytes.
export const REDX_MAX_BYTES = 256 * 1024;
// `redx-1`'s layout: the two-digit year, the month and the day of creation,
// each under ten written as A and the digit, the weekday's first two letters,
// and the parcel's serial in base 36.
const NUMBER = /^2\d(?:A[1-9]|1[0-2])(?:A[1-9]|[12]\d|3[01])(?:MO|TU|WE|TH|FR|SA|SU)[0-9A-Z]{4,6}$/;
// Bangladesh's one zone, which the page shows a visitor there.
const ZONE = 'Asia/Dhaka';
// The reply's clocks are UTC instants, to the millisecond.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const NOT_FOUND = 'no parcel data found!';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Whoever a scan names after "by": the rider on the way, with their phone
// number and sometimes the areas they serve.
const BY = /\s+by\b[\s\S]*$/i;

/** A RedX tracking ID, in capitals; anything else is not one RedX issues. */
export function normalizeRedxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'RedX tracking IDs are a date, a weekday and four to six letters and digits');
  }
  return number;
}

/** A text field, required unless `optional`; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500, optional = false): string {
  const value = row[key];
  if (optional && (value === null || value === undefined)) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `RedX returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's English wording without the person it names after "by" or any
 * phone number: "Parcel is on the way to delivery by …(…)" becomes "Parcel is
 * on the way to delivery".
 */
export function redxWording(message: string): string {
  return clean(message.replace(BY, '').replace(PHONE, '').replace(/\(\s*\)/g, '')).replace(/[\s,;:\-–]+$/, '');
}

/** A scan's moment, an instant in UTC, at Bangladesh's offset. */
function instant(value: string): { iso: string; timestamp: number } {
  const parsed = INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'RedX returned an invalid scan time');
  return { iso: parsed.setZone(ZONE).toISO({ suppressMilliseconds: true })!, timestamp: parsed.toMillis() };
}

function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } | null {
  const description = redxWording(text(row, 'messageEn', 2_000));
  const clock = instant(text(row, 'time', 40));
  // The action names the scan; the parcel's status beside it repeats for unrelated scans.
  const code = text(row, 'action', 80, true).toLowerCase();
  if (!description) return null;
  const staged = redxStage(code, description);
  const event: CarrierEvent = {
    time: clock.iso,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.timestamp, code, description]), timestamp: clock.timestamp, event };
}

/**
 * The reply of RedX's `/v1/logistics/global-tracking/{id}`, which its public
 * tracking page reads. It answers HTTP 200 with `isError` and "No parcel data
 * found!" for an ID it does not know. A history names no ID: the lookup is
 * bound to the whole ID in its path, which the service matches exactly.
 */
export function parseRedx(payload: unknown, raw: string): CarrierResult {
  normalizeRedxNumber(raw);
  if (!isRecord(payload) || typeof payload.isError !== 'boolean') throw new SchemaError(PROVIDER, 'RedX returned an invalid envelope');
  if (payload.isError) {
    if (cleanScalar(payload.message, 80).toLowerCase() === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'RedX returned an unexpected error');
  }
  const rows = payload.tracking;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'RedX returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'RedX returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'RedX returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // The page reads an empty history as no parcel, but the service did not say so.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same moment keep the reply's order, oldest first.
  const events = scans.reverse().sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
