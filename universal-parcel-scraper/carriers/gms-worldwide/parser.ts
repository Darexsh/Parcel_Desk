import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gmsStage } from './status.js';

export const PROVIDER = 'GMS Worldwide Express';
// A long history is a few kilobytes.
export const GMS_MAX_BYTES = 256 * 1024;
/** The lookup's answer for a consignment number it has nothing for. */
export const GMS_NO_DATA = 'NO DATA';
// Nine digits, as consignment numbers are printed and quoted.
const NUMBER = /^\d{9}$/;
// Every scan names the GMS office that recorded it, and GMS's offices are in
// India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// A scan's day and clock, as "06 Mar 2026" and "12:48:05 pm".
const SCAN_DAY = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;
const SCAN_CLOCK = /^(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/i;
const CLOCK = 'dd MMM yyyy hh:mm:ss a';
// "Delivered to …" or "Delivered (POD) - received by …" could name who took
// the consignment, so a delivery keeps its words before that.
const DELIVERED_TO = /^((?:Consignment\s+)?Delivered(?:\s*\(POD\))?)\s*[-,:]?\s*\b(?:(?:received|signed|taken|collected)\s+)?(?:to|by)\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
// An office's name holds no PIN code; a place with one could be an address.
const PIN_CODE = /\d{6}/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GMS consignment number: nine digits. Anything else is not one GMS issues. */
export function normalizeGmsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GMS Worldwide Express consignment numbers are nine digits');
  return number;
}

/**
 * A text field. The reply is converted from XML, so an empty field is an
 * empty object, which the page reads as no value; anything else is a changed reply.
 */
function text(value: unknown, what: string, maxLength = 300): string {
  if (value === null || value === undefined || (isRecord(value) && !Object.keys(value).length)) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GMS Worldwide Express returned an invalid ${what}`);
  return clean(value, maxLength);
}

/** A wording without phone numbers; a delivery loses whom it names. */
export function gmsWording(wording: string): string {
  return clean(wording.replace(DELIVERED_TO, '$1').replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's wall clock, read in India and read back unchanged, as an instant. */
function scanTime(date: string, time: string): string {
  const day = SCAN_DAY.exec(date);
  const clock = SCAN_CLOCK.exec(time);
  if (day && clock) {
    const month = `${day[2]!.charAt(0).toUpperCase()}${day[2]!.slice(1).toLowerCase()}`;
    const local = `${day[1]!.padStart(2, '0')} ${month} ${day[3]} ${clock[1]!.padStart(2, '0')}:${clock[2]}:${clock[3]} ${clock[4]!.toUpperCase()}`;
    const wall = firstOccurrence(DateTime.fromFormat(local, CLOCK, { zone: ZONE, locale: 'en-US' }));
    // Luxon rolls an impossible day over; only a clock that reads back unchanged is kept.
    if (wall.isValid && wall.toFormat(CLOCK, { locale: 'en-US' }) === local) return wall.toUTC().toISO({ suppressMilliseconds: true });
  }
  throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an invalid scan time');
}

interface Scan { event: CarrierEvent; at: string; index: number; key: string }

/** One row of `Scans.ScanDetail`: its day and clock, the office that recorded it as `Scan`, and its wording as `Cnstatus`. */
function projectRow(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an invalid scan');
  const description = gmsWording(text(row.Cnstatus, 'scan wording'));
  if (!description) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned a scan without wording');
  const time = scanTime(text(row.ScanDate, 'scan date', 20), text(row.ScanTime, 'scan time', 20));
  const office = clean(text(row.Scan, 'scan office', 120).replace(PHONE, ''), 120).replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
  const location = PIN_CODE.test(office) ? '' : office;
  const staged = gmsStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: time, index, key: JSON.stringify([time, description, location]) };
}

/** The rows of `Scans.ScanDetail`: a list, one row on its own, or none. */
function scanRows(scans: unknown): unknown[] {
  if (scans === null || scans === undefined) return [];
  if (!isRecord(scans)) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned invalid scans');
  const detail = scans.ScanDetail;
  if (detail === null || detail === undefined || (isRecord(detail) && !Object.keys(detail).length)) return [];
  if (Array.isArray(detail)) return detail;
  if (isRecord(detail)) return [detail];
  throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned invalid scans');
}

/**
 * The reply of the tracking page's lookup, `get-consignment.php?cnno={number}`.
 * A consignment it knows is an `Order` naming its number in `@attributes`,
 * with a summary status and its scans, newest first; one it does not know is
 * `{"Status":"NO DATA"}`. Only the number, the scans and the summary status
 * are read; the consignee's details, references, images and booking fields are not.
 */
export function parseGms(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGmsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an invalid reply');
  const order = payload.Order;
  if (order === undefined) {
    if (typeof payload.Status !== 'string') throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an invalid reply');
    if (clean(payload.Status, 40) === GMS_NO_DATA) throw new NotFoundError(PROVIDER);
    // The home page reports any other answer as an invalid entry, not as a missing consignment.
    throw new IndeterminateError(PROVIDER, 'GMS Worldwide Express did not complete the lookup');
  }
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an invalid consignment');
  const attributes = order['@attributes'];
  if (!isRecord(attributes) || typeof attributes.trackingNo !== 'string') {
    throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned a consignment without its number');
  }
  if (attributes.trackingNo.length > 64 || normalizeTrackingNumber(attributes.trackingNo) !== number) {
    throw new IndeterminateError(PROVIDER, 'GMS Worldwide Express answered for another consignment');
  }
  const rows = scanRows(order.Scans);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow(row, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  // Newest first. Rows on one clock come in either order, so a delivery among
  // them is the newest; the others keep the reply's order, which is newest first.
  const delivered = (scan: Scan) => (scan.event.stage === 'delivered' ? 0 : 1);
  const events = scans.sort((a, b) => (a.at === b.at ? delivered(a) - delivered(b) || a.index - b.index : a.at < b.at ? 1 : -1))
    .map(({ event }) => event);

  const summary = text(order.Cnstatus, 'status', 200);
  if (!events.length) {
    // The page shows the summary's status over "No Data Available." for the history.
    if (!summary) throw new NoHistoryError(PROVIDER);
    const summed = gmsStage(gmsWording(summary));
    return {
      status: summed ? languageStageStatus(summed.stage) : 'unknown',
      ...(summed ? { current_stage: summed.stage, current_stage_source: summed.source } : {}),
      last_status_text: gmsWording(summary),
      last_update: null,
      expected_delivery: null,
      timezone: ZONE,
      summary_only: true,
      events: [],
    };
  }

  // The scans set the stage: the summary's status can lag them.
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
