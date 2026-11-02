import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postmediaStage } from './status.js';

export const PROVIDER = 'Postmedia Parcel Services';
// A delivered parcel's reply is about a kilobyte.
export const POSTMEDIA_MAX_BYTES = 256 * 1024;
// `BNI` and nine digits, as the tracker's lookups show them.
const NUMBER = /^BNI\d{9}$/;
// A Canadian postal code without its space.
const POSTCODE = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The reply for a number and postal code the tracker holds no parcel under.
const NO_MATCH = /\bdid not match our records\b/i;
const MAX_ROWS = 200;
// The page writes a province's name for its code; a scan may give either.
const PROVINCES: Readonly<Record<string, string>> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

/** A number for the tracker, in capitals as its page sends it; anything else is not one Postmedia Parcel Services issues. */
export function normalizePostmediaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Postmedia Parcel Services numbers are BNI and nine digits');
  return number;
}

/**
 * The recipient's postal code, which the tracker asks for with every number,
 * in capitals as the page sends it. The page puts a space in the middle of a
 * six-character code, so a Canadian one goes with a space after its first
 * three characters, however it was typed. The tracker itself checks any
 * other code.
 */
export function normalizePostmediaPostcode(raw: string | null | undefined): string {
  const typed = deliveryPostcodeText(raw ?? '');
  if (!typed) throw new InputRequiredError(PROVIDER, 'postcode', 'Postmedia Parcel Services shows a parcel only with the recipient\'s postal code');
  if (!DELIVERY_POSTCODE.test(typed)) throw new InvalidInputError(PROVIDER, 'Postmedia Parcel Services requires a valid recipient postal code');
  const compact = typed.replace(/[\s-]/g, '');
  return POSTCODE.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : typed;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Postmedia Parcel Services returned an invalid ${key}`);
  const cleaned = clean(value, maxLength);
  // The page shows the text "null" as no message.
  return cleaned.toLowerCase() === 'null' ? '' : cleaned;
}

/**
 * A scan's `event_date_time`, written without an offset. The page says all
 * its times are in GMT, and archived replies agree: read in any Canadian
 * zone, their newest scans would come after the reply was captured.
 */
function scanTime(value: string): { time: string; at: number } {
  const match = CLOCK.exec(value);
  const instant = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(instant, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== instant) {
    throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned an invalid scan time');
  }
  return { time: `${instant}Z`, at: parsed.toMillis() };
}

/** A scan's town and province, the province by name as the page writes it. */
function placeOf(row: Record<string, unknown>): string {
  const town = text(row, 'event_city', 80);
  const province = text(row, 'event_province', 60);
  return [town, PROVINCES[province.toUpperCase()] ?? province].filter(Boolean).join(', ');
}

interface Scan { at: number; index: number; key: string; event: CarrierEvent }

/** A scan, or null when it has no message in either language: the page shows "N/A" for it. */
function projectRow(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned an invalid scan');
  const { time, at } = scanTime(text(row, 'event_date_time', 40));
  const description = text(row, 'parcel_status_message') || text(row, 'parcel_status_message_french');
  if (!description) return null;
  const location = placeOf(row);
  const staged = postmediaStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, index, key: JSON.stringify([at, description, location]), event };
}

/** The expected delivery day, which the page shows as it is given. */
function expectedDay(payload: Record<string, unknown>): string | null {
  const day = text(payload, 'expected_delivery_date', 32);
  return DAY.test(day) && DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/**
 * The tracker's reply for one number and postal code: the parcel's number,
 * its expected delivery day and its scans, each with a town, a province and a
 * message in English and French. A number and postal code it holds nothing
 * under get `missing_error`, the page's "we don't have information for the
 * package": a wrong number, a wrong postal code, or a parcel the sender has
 * not announced yet. The parcel's order date, its record ids and the pickup
 * point's address and description are never read.
 */
export function parsePostmedia(payload: unknown, raw: string): CarrierResult {
  const number = normalizePostmediaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned an invalid reply');
  if (Object.hasOwn(payload, 'missing_error')) {
    if (typeof payload.missing_error === 'string' && NO_MATCH.test(payload.missing_error)) {
      throw new NotFoundError(PROVIDER, 'Postmedia Parcel Services has no parcel under this number and postal code');
    }
    throw new SchemaError(PROVIDER, 'Postmedia Parcel Services answered with an unknown notice');
  }
  if (typeof payload.tracking_id !== 'string') throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned a parcel without its number');
  if (normalizeTrackingNumber(clean(payload.tracking_id, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Postmedia Parcel Services answered for another parcel');
  }
  const rows = payload.statuses;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Postmedia Parcel Services returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow(row, index);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page sorts them; the reply lists the oldest first, so a later row is newer on one clock.
  const events = scans.sort((a, b) => b.at - a.at || b.index - a.index).map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' ? null : expectedDay(payload),
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events,
  };
}
