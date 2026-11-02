import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gdexStage } from './status.js';

export const PROVIDER = 'GDEX';
// A long history is a few kilobytes.
export const GDEX_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Kuala_Lumpur';
// Consignment notes print ten digits, or MY and eleven digits.
const NUMBER = /^(?:\d{10}|MY\d{11})$/;
// "2026-05-04T17:45:18", optionally with a fraction of a second.
const WALL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GDEX consignment number, in upper case; anything else is not one GDEX issues. */
export function normalizeGdexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GDEX consignment numbers are ten digits, or MY and eleven digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GDEX returned an invalid ${key}`);
  return clean(value, maxLength);
}

// Whoever a delivery scan names after its own word: "Delivered to …", "Delivered (…)".
const DELIVERED_TO = /^(delivered)\s*(?:[,;:.\-–(]|\b(?:to|by)\b)[\s\S]*$/i;
// A receiver or signer named after any other scan's words.
const RECEIVER = /\s*[,;:.\-–(]?\s*\b(?:received|signed) by\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** A scan's wording, without the person a delivery names, a receiver or signer, or phone numbers. */
export function gdexWording(raw: string): string {
  const own = clean(raw).replace(DELIVERED_TO, '$1').replace(RECEIVER, '').replace(PHONE, '');
  return clean(own).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's `updatedAt`: the branch's wall clock, with no zone. GDEX scans in
 * Malaysia, whose clock has no daylight saving, so it is read in
 * `Asia/Kuala_Lumpur`.
 */
function scanTime(row: Record<string, unknown>): string {
  const wall = WALL.exec(text(row, 'updatedAt', 40))?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only. Luxon rolls 24:00:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!wall || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'GDEX returned an invalid scan time');
  }
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = gdexWording(text(row, 'description', 500));
  if (!description) throw new SchemaError(PROVIDER, 'GDEX returned a scan without wording');
  const time = scanTime(row);
  const location = text(row, 'location', 120);
  // The app's category for the scan: "Pickup", "In Transit", "Out For Delivery", "Delivered".
  const code = text(row, 'status', 40);
  const staged = gdexStage(code, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, code, description, location]), event };
}

/** The entry of the search reply for the number asked. */
function entryFor(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'GDEX returned an invalid envelope');
  const entries = payload.data;
  if (!entries.length) throw new SchemaError(PROVIDER, 'GDEX answered without a consignment');
  if (entries.some((entry) => !isRecord(entry) || typeof entry.trackingNumber !== 'string')) {
    throw new SchemaError(PROVIDER, 'GDEX returned a consignment without its number');
  }
  const matching = (entries as Record<string, unknown>[])
    .filter((entry) => clean(entry.trackingNumber as string, 64).toUpperCase() === number);
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'GDEX answered for another consignment');
  return matching[0]!;
}

/**
 * The reply of the GDEX app's `/api/trackings?search=` for one number: one
 * entry per number searched. A number GDEX has no record of comes back with
 * `valid: false` and no data, which the app and the tracking page report as
 * not found. A known consignment's scans are in `data.trackStatuses`, newest
 * first.
 */
export function parseGdex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGdexNumber(raw);
  const entry = entryFor(payload, number);
  if (entry.valid === false) {
    if (entry.data === null || entry.data === undefined) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'GDEX returned data for a consignment it calls invalid');
  }
  if (entry.valid !== true) throw new SchemaError(PROVIDER, 'GDEX returned an invalid validity flag');
  const data = entry.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'GDEX returned a consignment without its record');
  const rows = data.trackStatuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GDEX returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GDEX returned an oversized history');

  const seen = new Set<string>();
  const projected: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GDEX returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    projected.push(scan.event);
  }
  if (!projected.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the app lists them; a reply listed oldest first is turned round.
  const instant = (event: CarrierEvent) => Date.parse(event.time as string);
  const events = instant(projected[0]!) < instant(projected.at(-1)!) ? projected.reverse() : projected;

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
