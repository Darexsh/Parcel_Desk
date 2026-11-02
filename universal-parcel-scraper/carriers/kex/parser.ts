import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kexCodeKey, kexStage } from './status.js';

export const PROVIDER = 'KEX Express';
// A delivered parcel's reply, with its signature image, is about 20 kB.
export const KEX_MAX_BYTES = 1_000_000;
// What the tracker answers: eight to twenty letters and digits, at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,20}$/;
const ZONE = 'Asia/Bangkok';
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DUE = /^\d{2} [A-Z][a-z]{2} \d{4}$/;
// The answer for a number the tracker has no shipment for, and for one it cannot read.
const NOT_FOUND = new Set(['200', '400']);
// The placeholder a selling platform's number gets before the parcel reaches KEX.
const PLACEHOLDER = 'WKD';
// Station and distribution-centre scans, whose coordinates are the facility's.
// A delivery round's are the courier's or the recipient's and are not kept.
const FACILITY = /^(?:103|10[5-9]|110)$/;
// A run of nine or more digits, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ENTRIES = 30;
const MAX_ROWS = 500;

/** A number for KEX Express' tracker, in upper case as the page sends it; anything else is not one it issues. */
export function normalizeKexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'KEX Express numbers are eight to twenty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `KEX Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock in Bangkok, which keeps one offset all year. */
function scanClock(row: Record<string, unknown>): { time: string; at: number } {
  const local = text(row, 's_datetime', 32);
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  if (!CLOCK.test(local) || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'KEX Express returned an invalid scan time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

/** The facility's coordinates, written "lat,lon", on a station or distribution-centre scan. */
function facilityPoint(row: Record<string, unknown>, code: string) {
  if (!FACILITY.test(kexCodeKey(code))) return null;
  const parts = text(row, 'GEO_Location', 64).split(',');
  return parts.length === 2 ? eventPoint(parts[0], parts[1]) : null;
}

interface Scan { event: CarrierEvent; at: number; order: number }

function projectRow(row: Record<string, unknown>, order: number): Scan {
  const code = cleanScalar(row.s_code, 16).toUpperCase();
  const description = clean(text(row, 's_desc').replace(PHONE, ''), 300);
  if (!description) throw new SchemaError(PROVIDER, 'KEX Express returned a scan without wording');
  const when = scanClock(row);
  const location = text(row, 'loc', 120);
  const point = facilityPoint(row, code);
  const staged = kexStage(code, description);
  const event: CarrierEvent = {
    time: when.time,
    ...(location ? { location } : {}),
    ...(point ? { point } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: when.at, order };
}

/** The progress rail's current step, which the page files a parcel under: delivered or returned. */
function railStage(icon: unknown): Stage | undefined {
  if (!isRecord(icon) || !Array.isArray(icon.display) || typeof icon.current_idx !== 'number') return undefined;
  const step: unknown = icon.display[icon.current_idx];
  const code = isRecord(step) ? cleanScalar(step.code, 8) : '';
  if (code === '400') return 'delivered';
  if (code === '401') return 'returned';
  return undefined;
}

/** The due date the page shows, as "02 Oct 2026"; a calendar day. */
function dueDate(shipment: Record<string, unknown>): string | null {
  const value = text(shipment, 'edt', 32);
  if (!DUE.test(value)) return null;
  const parsed = DateTime.fromFormat(value, 'dd MMM yyyy', { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/**
 * The tracking page's reply for one number: an array with an entry per
 * number asked, each echoing the number and holding the shipment and its
 * scans newest first. A number the tracker has no shipment for comes back
 * with a null shipment, which the page shows as not found. The sender's and
 * recipient's details, the signature and the delivery photos in the reply
 * are not read.
 */
export function parseKex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKexNumber(raw);
  if (isRecord(payload)) {
    if (payload.needCaptcha === true) throw new ChallengeError(PROVIDER, 'KEX Express asked for its slider captcha');
    // The service's own failure, as for the SF Express numbers it relays.
    if (payload.statusCode !== undefined) throw new IndeterminateError(PROVIDER, 'KEX Express did not complete the lookup');
  }
  if (!Array.isArray(payload) || payload.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'KEX Express returned an invalid envelope');
  if (!payload.every(isRecord)) throw new SchemaError(PROVIDER, 'KEX Express returned an invalid entry');
  const entry = (payload as Record<string, unknown>[])
    .find((candidate) => typeof candidate.tracking_no === 'string' && clean(candidate.tracking_no, 64).toUpperCase() === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'KEX Express answered for another shipment');
  const ref = entry.ref;
  if (!isRecord(ref)) throw new SchemaError(PROVIDER, 'KEX Express returned an entry without its shipment');
  const shipment = ref.shipment;
  if (shipment === null || shipment === undefined) {
    const code = isRecord(ref.sta) ? cleanScalar(ref.sta.code, 8) : '';
    if (NOT_FOUND.has(code)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'KEX Express did not complete the lookup');
  }
  if (!isRecord(shipment) || typeof shipment.con !== 'string') throw new SchemaError(PROVIDER, 'KEX Express returned a shipment without its number');
  if (clean(shipment.con, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'KEX Express answered for another shipment');
  const rows = ref.shipment_status ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'KEX Express returned a shipment with invalid scans');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, order) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'KEX Express returned an invalid scan');
    if (cleanScalar(row.s_code, 16).toUpperCase() === PLACEHOLDER) return;
    const scan = projectRow(row, order);
    const identity = JSON.stringify([scan.event.time, scan.event.provider_code, scan.event.description, scan.event.location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same second keep the reply's order, which is newest first.
  const events = scans.sort((a, b) => b.at - a.at || a.order - b.order).map(({ event }) => event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const rail = railStage(ref.icon);
  const stage = (rail ?? scanned?.stage) as Stage | undefined;
  const source = rail && rail !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const ended = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: ended ? null : dueDate(shipment),
    ...(delivered ? { delivered_at: delivered.time } : {}),
    events,
  };
}
