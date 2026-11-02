import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shadowfaxStage, shadowfaxSummaryStage } from './status.js';

export const PROVIDER = 'Shadowfax';
// A reply is a few kilobytes at most.
export const SHADOWFAX_MAX_BYTES = 256 * 1024;
// The delivery service's answer for a number it has no delivery request under.
export const NO_DELIVERY = 'No delivery Request exist with such awb';
// The tracker's own answer for a number Shadowfax does not know, which the page shows.
export const INVALID_AWB = 'Invalid AWB Number. Please check again.';
// Letters and digits with at least one digit. The tracker takes any text, and
// sellers print merchant codes of one to three letters after the digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// A wall clock to the second, sometimes with a fraction.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const ZONE = 'Asia/Kolkata';
// Where the wording names a facility.
const FACILITY = /\bShadowfax's (.{2,80}?) facility\b/i;
const BAG_ARRIVAL = /^Bag containing your shipment is received at (.{2,80})$/i;
// Phone numbers and one-time codes, should a rider's ever reach the wording.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const OTP = /\b(OTP)\b[\s:-]*(?:is\s+)?\d{4,8}\b/gi;
// The tracker's first milestone: a history that starts there is whole.
const FIRST_MILESTONE = /^order received\.?$/i;
const MAX_GROUPS = 50;
const MAX_SCANS = 300;
const MAX_EVENTS = 100;

/** A number for Shadowfax's tracker, in capitals; anything else is not one it issues. */
export function normalizeShadowfaxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shadowfax AWB numbers are eight to thirty letters and digits');
  return number;
}

/** The `message` of a reply, or '' without one. */
export function shadowfaxMessage(payload: unknown): string {
  return isRecord(payload) ? clean(payload.message, 200) : '';
}

/**
 * A milestone's heading, then a scan's own line, as the page lists the line
 * under its heading: `In Transit: Shipment is received at …`. Phone numbers
 * and one-time codes are dropped.
 */
export function shadowfaxWording(heading: string, line: string): string {
  const own = clean(line.replace(PHONE, '').replace(OTP, '$1').replace(/\s+([,;:.])/g, '$1'), 300)
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  if (!own) return heading;
  if (own.toLowerCase().startsWith(heading.toLowerCase().replace(/\.+$/, ''))) return own;
  return `${heading}: ${own}`;
}

/** The facility a scan's line names, if any. */
function facility(line: string): string {
  return clean(FACILITY.exec(line)?.[1] ?? BAG_ARRIVAL.exec(line)?.[1] ?? '', 80).replace(/[.\s]+$/, '');
}

/**
 * A scan's clock. The service sends India's wall clock without an offset, and
 * the tracker's own page reads it in `Asia/Kolkata`, which has no daylight
 * saving.
 */
function scanTime(value: unknown): string {
  const wall = typeof value === 'string' ? CLOCK.exec(value.trim())?.[1] : undefined;
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !checked?.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Shadowfax returned an invalid scan time');
  }
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

/** A required text field; anything but a non-empty string is a changed reply. */
function heading(row: Record<string, unknown>): string {
  const value = row.main_status;
  const text = typeof value === 'string' ? clean(value, 120) : '';
  if (!text) throw new SchemaError(PROVIDER, 'Shadowfax returned a milestone without its heading');
  return text;
}

/** A milestone's number, '' without one; only a whole number is one. */
function milestoneCode(row: Record<string, unknown>): string {
  const value = row.main_status_id;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError(PROVIDER, 'Shadowfax returned an invalid milestone number');
  }
  return String(value);
}

interface Scan {
  event: CarrierEvent;
  heading: string;
  at: number;
}

/** One milestone: its heading, its number, and its scans' lines and clocks side by side, newest first. */
function readMilestone(row: unknown): Scan[] {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Shadowfax returned an invalid milestone');
  const title = heading(row);
  const code = milestoneCode(row);
  const lines = row.sub_status ?? [];
  const clocks = row.time ?? [];
  if (!Array.isArray(lines) || !Array.isArray(clocks) || lines.length !== clocks.length) {
    throw new SchemaError(PROVIDER, 'Shadowfax returned a milestone whose scans and clocks differ');
  }
  return lines.map((line, index) => {
    if (typeof line !== 'string') throw new SchemaError(PROVIDER, 'Shadowfax returned an invalid scan');
    const time = scanTime(clocks[index]);
    const description = shadowfaxWording(title, line);
    const location = facility(line);
    const staged = shadowfaxStage(code, title, description);
    const event: CarrierEvent = {
      time,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { event, heading: title, at: DateTime.fromISO(time).toMillis() };
  });
}

/** The delivery estimate, a calendar day written as `02 October 2026, Friday`; anything else is none. */
function estimate(value: unknown): string | null {
  const text = clean(value, 60);
  if (!text) return null;
  const parsed = DateTime.fromFormat(text, 'dd MMMM yyyy, cccc', { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/**
 * The delivery service's reply for one AWB: the order's summary and the
 * scans of its current milestone, each milestone with its lines and clocks
 * newest first. The summary must name the number asked. A record without
 * scans is a parcel Shadowfax knows with no history to show.
 */
export function parseShadowfax(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShadowfaxNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.order_details)) throw new SchemaError(PROVIDER, 'Shadowfax returned an invalid reply');
  const order = payload.order_details;
  if (typeof order.awb_number !== 'string' || !clean(order.awb_number)) {
    throw new SchemaError(PROVIDER, 'Shadowfax returned an order without its number');
  }
  if (normalizeTrackingNumber(clean(order.awb_number, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Shadowfax answered for another shipment');
  }
  const milestones = payload.data ?? [];
  if (!Array.isArray(milestones) || milestones.length > MAX_GROUPS) throw new SchemaError(PROVIDER, 'Shadowfax returned invalid milestones');

  const scans = milestones.flatMap(readMilestone);
  if (scans.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Shadowfax returned too many scans');
  const seen = new Set<string>();
  // Newest first, whatever order the milestones come in; equal clocks keep the reply's order.
  const ordered = scans.filter(({ event }) => {
    const identity = JSON.stringify([event.time, event.provider_code, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => b.at - a.at);
  if (!ordered.length) throw new NoHistoryError(PROVIDER);

  const events = ordered.map(({ event }) => event);
  const newest = events[0]!;
  const summary = shadowfaxSummaryStage(cleanScalar(order.status_id, 40));
  const stage = (newest.stage ?? summary) as Stage | undefined;
  const source = newest.stage ? newest.stage_source : 'carrier_map';
  const ended = stage === 'delivered' || stage === 'returned';
  const expected = ended ? null : estimate(order.exp_delivery_date);
  // The page shows the current milestone's scans only, so the earlier ones are
  // missing unless the history still starts at the first milestone.
  const truncated = !FIRST_MILESTONE.test(ordered.at(-1)!.heading) || events.length > MAX_EVENTS;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: expected,
    ...(stage === 'delivered' ? { delivered_at: newest.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(truncated ? { history_truncated: true } : {}),
  };
}

/**
 * The tracker's lookup of a number the delivery service does not know. Its
 * not-found answer is the only one that settles it; a number it knows is
 * tracked by another Shadowfax service, which the adapter does not read.
 */
export function shadowfaxUnknown(status: number, payload: unknown, raw: string): never {
  const number = normalizeShadowfaxNumber(raw);
  if (status === 400 && shadowfaxMessage(payload) === INVALID_AWB) throw new NotFoundError(PROVIDER);
  const data = isRecord(payload) ? payload.data : undefined;
  if (status !== 200 || !isRecord(data) || typeof data.awb_number !== 'string') {
    throw new IndeterminateError(PROVIDER, 'Shadowfax did not complete the number lookup');
  }
  if (normalizeTrackingNumber(clean(data.awb_number, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Shadowfax answered for another shipment');
  }
  // `Connect` is the page's other view, for Shadowfax Connect orders.
  if (clean(data.type, 20) === 'Connect') {
    throw new IndeterminateError(PROVIDER, 'Shadowfax tracks this number in Shadowfax Connect, which the adapter does not read');
  }
  throw new IndeterminateError(PROVIDER, 'Shadowfax knows the number but its delivery service did not answer for it');
}
