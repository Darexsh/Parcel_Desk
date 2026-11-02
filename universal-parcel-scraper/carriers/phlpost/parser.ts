import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { phlpostStage } from './status.js';

export const PROVIDER = 'PHLPost';
// A long history is a few kilobytes.
export const PHLPOST_MAX_BYTES = 512 * 1024;

const ZONE = 'Asia/Manila';
const MAX_ROWS = 500;
// IPS clocks, day first, to the second: "21/05/2026 10:28:49 am".
const IPS_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([ap]m)$/i;
// The domestic system's clocks, to the minute, as SQL Server writes them: "May 2 2026  3:09PM".
const DOMESTIC_CLOCK = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{1,2}):(\d{2})([AP]M)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CODE = /^\d{1,4}$/;
// A delivery names who signed for it: "Item delivered - Received by … (Relative)",
// "Item delivered (RECEIVED BY …)". Only the delivery itself is kept.
const RECEIVER = /^(item delivered)\s*(?:-\s*|\(\s*)received by\b[\s\S]*$/i;
// A run of seven or more digits, as phone numbers are written.
const PHONE = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;

/**
 * PHLPost's tracker looks up UPU S10 item codes: its own, ending PH, and those
 * of the posts that send mail to the Philippines. The code needs a valid check digit.
 */
export function normalizePhlpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'PHLPost tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PHLPost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A wall clock as ISO digits, checked against the calendar; parsing in UTC assigns no offset. */
function digits(year: string, month: number, day: string, hour12: string, minute: string, second: string, meridiem: string): string {
  const hour = Number(hour12);
  if (hour < 1 || hour > 12) throw new SchemaError(PROVIDER, 'PHLPost returned an invalid scan time');
  const hours = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const local = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}T${String(hours).padStart(2, '0')}:${minute}:${second}`;
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local || parsed.year < 1990) {
    throw new SchemaError(PROVIDER, 'PHLPost returned an invalid scan time');
  }
  return local;
}

/**
 * A row's `StatusDateStrings`, the clock the page shows. IPS rows give the
 * office's wall clock to the second; rows of the domestic delivery system
 * give it to the minute. The reply's `EventDate` is the same wall clock read
 * as UTC+8 by the server, so it settles no zone and is not read.
 */
function rowClock(value: string): { local: string; domestic: boolean } {
  const ips = IPS_CLOCK.exec(value);
  if (ips) return { local: digits(ips[3]!, Number(ips[2]), ips[1]!, ips[4]!, ips[5]!, ips[6]!, ips[7]!), domestic: false };
  const domestic = DOMESTIC_CLOCK.exec(value);
  const month = domestic ? MONTHS.indexOf(domestic[1]!) + 1 : 0;
  if (!domestic || !month) throw new SchemaError(PROVIDER, 'PHLPost returned an invalid scan time');
  return { local: digits(domestic[3]!, month, domestic[2]!, domestic[4]!, domestic[5]!, '00', domestic[6]!), domestic: true };
}

/** An IPS row's country, which IPS names in ISO's style: "United States of America (the)". */
function place(row: Record<string, unknown>): string {
  return text(row, 'Location', 120).replace(/\s*\(the\)$/i, '');
}

/** A row's wording without the name of whoever signed for a delivery, or phone numbers. */
export function phlpostWording(event: string): string {
  return clean(clean(event, 300).replace(RECEIVER, '$1').replace(PHONE, ''));
}

interface Scan { event: CarrierEvent; local: string; country: string | null; domestic: boolean; index: number }

/**
 * One row. The domestic system's rows name no place and are PHLPost's own
 * offices; IPS rows name the country of the office. Both clocks are the
 * office's: a scan in the Philippines reads on Manila time, and one abroad,
 * or in a country the row does not settle, keeps its wall clock.
 */
function scanOf(row: Record<string, unknown>, index: number): Scan {
  const code = cleanScalar(row.StatusCode, 8);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'PHLPost returned a scan without a status code');
  const description = phlpostWording(text(row, 'Event', 300));
  if (!description) throw new SchemaError(PROVIDER, 'PHLPost returned a scan without wording');
  const { local, domestic } = rowClock(text(row, 'StatusDateStrings', 40));
  const location = place(row);
  const country = (location ? countryCode(location) : null) ?? (domestic ? 'PH' : null);
  const time = country === 'PH' ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toISO({ suppressMilliseconds: true })! : null;
  const staged = phlpostStage(description);
  const event: CarrierEvent = {
    ...(time ? { time } : { local_time: local }),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, local, country, domestic, index };
}

const NOT_FOUND = /^not found$/i;

/** The tracker's own answer for a code it does not know: one row that says so, without a date. */
function notFound(row: Record<string, unknown>): boolean {
  return NOT_FOUND.test(text(row, 'Event', 40)) && cleanScalar(row.StatusCode, 8) === '0'
    && (row.EventDate === null || row.EventDate === undefined) && !text(row, 'StatusDateStrings', 40);
}

/**
 * The country the item was sent to: IPS's arrival in the country of
 * destination, else the Philippines when PHLPost's domestic system sent it to
 * a delivery office, delivered it or tried to. Its acceptance of an item says
 * nothing about where the item goes.
 */
function destination(scans: readonly Scan[]): string | null {
  const arrival = scans.find(scan => /^receive at country of destination$/i.test(scan.event.description!) && scan.country);
  if (arrival) return arrival.country;
  const delivery = scans.some(scan => scan.domestic && (/\bdelivery office\b/i.test(scan.event.description!)
    || ['out_for_delivery', 'failed_attempt', 'delivered'].includes(scan.event.stage as string)));
  return delivery ? 'PH' : null;
}

/**
 * The reply of the tracking page's `POST /Home/GetTrackingEventsJson` for one
 * code: an array of rows, each naming the code. The domestic system's rows come
 * first, then the IPS rows, each part newest first. A code the tracker does not
 * know comes back as one "Not Found" row.
 */
export function parsePhlpost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePhlpostNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'PHLPost returned an invalid reply');
  if (!payload.length) throw new IndeterminateError(PROVIDER, 'PHLPost returned no rows for the code');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PHLPost returned an oversized history');
  const rows = payload.map((row: unknown) => {
    if (!isRecord(row) || typeof row.TrackingNo !== 'string') throw new SchemaError(PROVIDER, 'PHLPost returned a row without its code');
    if (normalizeTrackingNumber(clean(row.TrackingNo, 64)) !== number) throw new IndeterminateError(PROVIDER, 'PHLPost answered for another item');
    return row;
  });
  if (rows.length === 1 && notFound(rows[0]!)) throw new NotFoundError(PROVIDER);
  // Its "Not Found" anywhere else, among scans or with a date, is a reply that changed.
  if (rows.some(row => NOT_FOUND.test(text(row, 'Event', 40)))) throw new SchemaError(PROVIDER, 'PHLPost returned an unexpected not-found row');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index);
    // A row the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first by wall clock, as the page orders IPS rows, so the domestic rows
  // take their place among them; rows at the same clock keep the reply's order.
  scans.sort((left, right) => right.local > left.local ? 1 : right.local < left.local ? -1 : left.index - right.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time ?? null : null;
  const country = destination(scans);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
