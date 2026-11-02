import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { trackonStage } from './status.js';

export const PROVIDER = 'Trackon';
// A long history is a few kilobytes.
export const TRACKON_MAX_BYTES = 256 * 1024;
// Twelve digits, or ten on older consignments.
const NUMBER = /^(?:\d{10}|\d{12})$/;
// Every scan is at a Trackon branch in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
const CLOCK = 'dd/MM/yyyy HH:mm:ss';
const FOUND = 'success';
// The service's answer for a number of a Trackon series it has no consignment for.
const MISSING = 'not found';
// The service's answer for a number outside the series Trackon issues.
const NOT_TRACKON = 'please enter trackon awbno';
// A branch code before the branch's name and state, as in "NRTH-NORTHPUR BRANCH, SAMPLE STATE".
const BRANCH_CODE = /^[A-Z0-9]{2,12}\s*-\s*(?=\S)/;
// A delivery scan's remark after its wording: "DELIVERED WITH MOBILE APP UPDATE - NULL".
const REMARK = /\s+-\s+[\s\S]*$/;
const PLACEHOLDER = /\bNULL\b/gi;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Trackon AWB number: twelve digits, or ten. Anything else is not a number Trackon issues. */
export function normalizeTrackonNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Trackon AWB numbers are twelve or ten digits');
  return number;
}

/** A text field; anything but a string, or null, is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Trackon returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock, read in India and read back unchanged, as an instant. */
function scanTime(date: string, time: string): string {
  const local = `${date} ${time}`;
  const wall = firstOccurrence(DateTime.fromFormat(local, CLOCK, { zone: ZONE }));
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!wall.isValid || wall.toFormat(CLOCK) !== local) throw new SchemaError(PROVIDER, 'Trackon returned an invalid scan time');
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/**
 * A scan's wording without phone numbers. A delivery or return loses the remark
 * the service puts after it, which can name who took the consignment.
 */
export function trackonWording(status: string, stage?: string): string {
  const own = stage === 'delivered' || stage === 'returned' ? status.replace(REMARK, '') : status;
  return clean(own.replace(PHONE, '').replace(PLACEHOLDER, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The branch a scan names, without its code. */
function branch(value: string): string {
  return clean(value.replace(BRANCH_CODE, ''), 120);
}

interface Scan { event: CarrierEvent; at: string }

function projectRow(row: unknown): (Scan & { key: string }) | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Trackon returned an invalid scan');
  const status = text(row, 'CURRENT_STATUS');
  const code = text(row, 'TRACKING_CODE', 16).toUpperCase();
  // The service answers some numbers it has nothing for with one empty scan
  // dated 01-Jan-0001: a placeholder, not a scan.
  if (!status && !code) return null;
  if (!status) throw new SchemaError(PROVIDER, 'Trackon returned a scan without wording');
  const time = scanTime(text(row, 'EVENTDATE', 16), text(row, 'EVENTTIME', 16));
  const staged = trackonStage(code, status);
  const description = trackonWording(status, staged?.stage);
  if (!description) throw new SchemaError(PROVIDER, 'Trackon returned a scan without wording');
  const location = branch(text(row, 'CURRENT_CITY'));
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: time, key: JSON.stringify([time, code, description, location]) };
}

/**
 * The reply of the Android app's `CustDetailTracking` for one AWB number:
 * `summaryTrack` names the consignment and its current status, `lstDetails`
 * lists its scans newest first, and `ResponseStatus.Message` says how the
 * lookup went. The consignor, consignee, postcode, reference, weight, booking
 * details and proof-of-delivery images are not read.
 */
export function parseTrackon(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTrackonNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.ResponseStatus) || typeof payload.ResponseStatus.Message !== 'string') {
    throw new SchemaError(PROVIDER, 'Trackon returned an invalid envelope');
  }
  const message = clean(payload.ResponseStatus.Message, 300).toLowerCase();
  if (message !== FOUND) {
    if (message === MISSING) throw new NotFoundError(PROVIDER);
    if (message === NOT_TRACKON) throw new InvalidInputError(PROVIDER, 'Trackon says the number is not one of its AWB numbers', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Trackon did not complete the lookup');
  }
  const summary = payload.summaryTrack;
  if (!isRecord(summary) || typeof summary.AWBNO !== 'string') throw new SchemaError(PROVIDER, 'Trackon returned a consignment without its number');
  if (summary.AWBNO.length > 64 || normalizeTrackingNumber(summary.AWBNO) !== number) {
    throw new IndeterminateError(PROVIDER, 'Trackon answered for another consignment');
  }
  const rows = payload.lstDetails ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Trackon returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Trackon returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1)).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
