import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lineClearStage } from './status.js';

export const PROVIDER = 'Line Clear';
// A long history is a few kilobytes.
export const LINE_CLEAR_MAX_BYTES = 512 * 1024;
// Line Clear's waybills seen so far are a letter or three and thirteen to fifteen digits; the
// tracker takes any text. Letters and digits, at least one digit, keep a comma or a wildcard
// from reaching it.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// Malaysia keeps one zone, without daylight saving time.
const ZONE = 'Asia/Kuala_Lumpur';
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
// Luxon reads 24:00:00 as the next midnight, which no scan clock shows.
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
// A branch or hub code, as "DCTH" or "HBCTH01XYZ".
const BRANCH = /^[A-Z0-9]{2,20}$/;
// The tracker's answer for a search that found none of its numbers.
const NONE_FOUND = /^The waybill number\(s\) entered is invalid or does not exist in the system$/i;
// Its answer for one number of a search that found others.
const ONE_NOT_FOUND = /^The WayBillNumber '([^']{1,64})' is invalid or does not exist in the system$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone
// numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Scans the tracking page leaves out of the history it shows.
const HIDDEN = new Set(['WB005', 'WB007', 'WB010', 'WB014', 'WB016', 'WB019', 'WB022', 'WB023', 'WB025', 'WB026', 'WB056']);
// Delivery run sheet scans (WB055) the page leaves out, by their undelivered code.
const HIDDEN_RUN_SHEET = new Set(['DD012V001', 'DD012V002']);
// The page's own words for a scan whose status it rewords.
const REWORDED: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['WB013', ['Manifest Out Scan completed', 'Transit Cage Out']],
  ['WB017', ['Ready for Delivery', 'Parcel has Arrived']],
]);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Line Clear waybill number, in capitals; anything else is not one Line Clear issues. */
export function normalizeLineClearNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Line Clear waybill numbers are eight or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Line Clear returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Text without phone numbers. */
function scrubbed(value: string): string {
  return clean(value.replace(PHONE, '')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's `LastModifiedDate` and `LastModifiedTime`: the branch's wall clock, read in Malaysia's zone. */
function scanTime(row: Record<string, unknown>): { time: string; at: number } {
  const date = text(row, 'LastModifiedDate', 16);
  const clock = text(row, 'LastModifiedTime', 16);
  const zoned = firstOccurrence(DateTime.fromFormat(`${date} ${clock}`, 'dd/MM/yyyy HH:mm:ss', { zone: ZONE }));
  // Luxon refuses a day the month does not have.
  if (!DATE.test(date) || !CLOCK.test(clock) || !zoned.isValid) throw new SchemaError(PROVIDER, 'Line Clear returned an invalid scan time');
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

/**
 * A scan's wording: its status, as the page words it. An undelivered scan
 * adds its reason, as the page does. The staff member each scan's
 * description names is not read.
 */
function wording(row: Record<string, unknown>, code: string): string {
  const status = text(row, 'Status');
  const [from, to] = REWORDED.get(code) ?? ['', ''];
  const own = from ? status.replace(from, to) : status;
  const reason = scrubbed(text(row, 'UndelReason'));
  if (!reason || !(code === 'WB020' || (code === 'WB055' && text(row, 'UndelCode', 20) === 'DD012V003'))) return scrubbed(own);
  return scrubbed(`${own}: ${reason.charAt(0).toUpperCase()}${reason.slice(1).toLowerCase()}`);
}

interface Scan { event: CarrierEvent; at: number }

function scanOf(row: Record<string, unknown>, number: string): Scan | null {
  const waybill = text(row, 'WayBillNumber', 64);
  if (!waybill) throw new SchemaError(PROVIDER, 'Line Clear returned a scan without its waybill number');
  if (normalizeTrackingNumber(waybill) !== number) throw new IndeterminateError(PROVIDER, 'Line Clear answered for another waybill');
  const code = text(row, 'StatusCode', 16).toUpperCase();
  if (HIDDEN.has(code) || (code === 'WB055' && HIDDEN_RUN_SHEET.has(text(row, 'UndelCode', 20)))) return null;
  const description = wording(row, code);
  if (!description) throw new SchemaError(PROVIDER, 'Line Clear returned a scan without its status');
  const when = scanTime(row);
  const branch = text(row, 'TransitLocation', 40).toUpperCase();
  const staged = lineClearStage(code, description);
  return {
    event: {
      time: when.time, description,
      // A branch code; the adapter puts the branch's place in its stead.
      ...(BRANCH.test(branch) ? { location: branch } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    at: when.at,
  };
}

/** The reply's scans of the number asked: its one list naming it. */
function rowsFor(payload: unknown, number: string): unknown[] {
  if (isRecord(payload)) {
    if (typeof payload.message === 'string' && NONE_FOUND.test(clean(payload.message))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Line Clear returned an invalid envelope');
  }
  if (!Array.isArray(payload) || !payload.length || payload.some((entry) => !Array.isArray(entry) || !entry.length)) {
    throw new SchemaError(PROVIDER, 'Line Clear returned an invalid envelope');
  }
  const named = (entry: unknown[]) => {
    const first = entry[0];
    if (!isRecord(first)) throw new SchemaError(PROVIDER, 'Line Clear returned an invalid scan');
    const missing = typeof first.message === 'string' ? ONE_NOT_FOUND.exec(clean(first.message)) : null;
    if (missing) return normalizeTrackingNumber(missing[1]!);
    if (typeof first.WayBillNumber !== 'string') throw new SchemaError(PROVIDER, 'Line Clear returned a scan without its waybill number');
    return normalizeTrackingNumber(first.WayBillNumber);
  };
  const matching = (payload as unknown[][]).filter((entry) => named(entry) === number);
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'Line Clear answered for another waybill');
  const rows = matching[0]!;
  if (isRecord(rows[0]) && typeof rows[0].message === 'string') {
    if (rows.length !== 1) throw new SchemaError(PROVIDER, 'Line Clear returned an invalid envelope');
    throw new NotFoundError(PROVIDER);
  }
  return rows;
}

/**
 * The reply of the tracking page's `viewandtrack` lookup for one waybill: one
 * list of scans per number searched. A search that found nothing is a
 * message, which the page reports as not found. Each scan must name the
 * waybill asked. Locations are branch codes, as the reply gives them.
 */
export function parseLineClear(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLineClearNumber(raw);
  const rows = rowsFor(payload, number);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Line Clear returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Line Clear returned an invalid scan');
    const scan = scanOf(row, number);
    if (!scan) continue;
    const { time, provider_code: code, description, location } = scan.event;
    const key = JSON.stringify([time, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The reply lists scans roughly newest first; they are put in clock order, newest
  // first, and scans sharing a second keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.at - a.at).map(({ event }) => event);

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

/** The branch codes a result's scans name, once each, for the page's branch lookup. */
export function lineClearBranches(result: CarrierResult): string[] {
  return [...new Set((result.events ?? []).map((event) => event.location ?? '').filter((code) => BRANCH.test(code)))];
}

/**
 * The reply of the page's branch lookup for `codes`: one entry per code, in
 * order, as "DCTH ( BANDAR CONTOH )", or the code alone for a branch it has no place
 * for. Gives each code its place, or the code itself.
 */
export function parseLineClearBranches(payload: unknown, codes: readonly string[]): Map<string, string> {
  if (!Array.isArray(payload) || payload.length !== codes.length) throw new SchemaError(PROVIDER, 'Line Clear returned an invalid branch list');
  const places = new Map<string, string>();
  for (const [index, code] of codes.entries()) {
    const entry: unknown = payload[index];
    if (typeof entry !== 'string') throw new SchemaError(PROVIDER, 'Line Clear returned an invalid branch');
    const shown = clean(entry, 120);
    const named = /^([A-Z0-9]+)\s*\(\s*([^()]+?)\s*\)$/i.exec(shown);
    if (named && named[1]!.toUpperCase() === code) places.set(code, named[2]!);
    else if (shown.toUpperCase() === code) places.set(code, code);
    else throw new SchemaError(PROVIDER, 'Line Clear answered for another branch');
  }
  return places;
}

/** A result whose scans name their branch's place instead of its code. */
export function withLineClearPlaces(result: CarrierResult, places: ReadonlyMap<string, string>): CarrierResult {
  return {
    ...result,
    events: (result.events ?? []).map((event) => {
      const place = event.location ? places.get(event.location) : undefined;
      return place ? { ...event, location: place } : event;
    }),
  };
}
