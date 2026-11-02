import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shreeAnjaniDeliveryStage, shreeAnjaniScanStage, shreeAnjaniWordingStage } from './status.js';

export const PROVIDER = 'Shree Anjani';
// A reply is about a kilobyte; a long history stays well under this.
export const SHREE_ANJANI_MAX_BYTES = 512 * 1024;
const ZONE = 'Asia/Kolkata';
// The lookup's own check: ten to fifteen digits. Dockets are ten.
const NUMBER = /^\d{10,15}$/;
// Every clock is a UTC instant, to the millisecond.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// The booking's day, stored as midnight UTC.
const DAY = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0{1,3})?Z$/;
// The sentence older scans give in place of their first centre: "Out To B From A", "Inward AT A".
const SENTENCE = /^(?:out|in|inward)\s+(?:to|at|from)\s+\S/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took the parcel, after a delivery's wording ("DELIVERED TO …").
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:to|by)\b[\s\S]*$/i;
const DELIVERED = /^delivered\b/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A docket number for Shree Anjani's tracker; anything else is not one it issues. */
export function normalizeShreeAnjaniNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shree Anjani numbers are ten to fifteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Shree Anjani returned an invalid ${key}`);
  return clean(value.replace(PHONE, ''), maxLength).replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** An instant the reply gives in UTC; null for an empty one. */
function instant(row: Record<string, unknown>, key: string): DateTime | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const at = typeof value === 'string' && INSTANT.test(value) ? DateTime.fromISO(value, { zone: 'utc' }) : null;
  if (!at?.isValid || at.year < 2000 || at.year >= 2100) throw new SchemaError(PROVIDER, `Shree Anjani returned an invalid ${key}`);
  return at;
}

/** An instant in India's zone, to the second, as the page shows it. */
const indian = (at: DateTime) => at.setZone(ZONE).startOf('second').toISO({ suppressMilliseconds: true })!;

/** A list in the reply; a missing one is empty. */
function rows(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key] ?? [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `Shree Anjani returned an invalid ${key}`);
  if (value.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shree Anjani returned an oversized history');
  return value.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Shree Anjani returned an invalid scan');
    return row;
  });
}

interface Scan {
  readonly at: number;
  /** Run sheets come after the scans of the same moment. */
  readonly rank: number;
  readonly event: CarrierEvent;
}

/**
 * A scan's line. Older scans put a sentence where the first centre goes, as
 * "Out To B From A"; newer ones name both centres, and get the same sentence.
 */
function scanWording(code: string, scanned: string, from: string, to: string): string {
  if (SENTENCE.test(from)) return from;
  if (code === 'OUT') {
    const origin = from || scanned;
    return to ? `Out To ${to}${origin && origin !== to ? ` From ${origin}` : ''}` : origin ? `Out From ${origin}` : 'Out';
  }
  if (code === 'IN') {
    const at = scanned || to;
    return at ? `Inward AT ${at}${from && from !== at ? ` From ${from}` : ''}` : from ? `Inward From ${from}` : 'Inward';
  }
  const route = [from, to].filter(Boolean).join(' -> ');
  return route ? `${code} (${route})` : code;
}

/** A hub or branch scan of `booking_tracking`. */
function projectScan(row: Record<string, unknown>): Scan {
  const code = text(row, 'status_name', 40).toUpperCase();
  if (!code) throw new SchemaError(PROVIDER, 'Shree Anjani returned a scan without a status');
  const at = instant(row, 'created_at');
  if (!at) throw new SchemaError(PROVIDER, 'Shree Anjani returned a scan without a time');
  const scanned = text(row, 'scanned_center_name', 120);
  const from = text(row, 'from_center_name');
  const to = text(row, 'to_center_name', 120);
  const description = scanWording(code, scanned, from, to);
  const location = scanned || (SENTENCE.test(from) ? '' : from);
  const staged = shreeAnjaniScanStage(code, description);
  return { at: at.toMillis(), rank: 0, event: {
    time: indian(at),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * A delivery run sheet entry of `drs_list`: the branch that sent the parcel
 * out and what came of the run. A delivery keeps no clause naming who took it.
 */
function projectRun(row: Record<string, unknown>): Scan {
  const at = instant(row, 'drs_date');
  if (!at) throw new SchemaError(PROVIDER, 'Shree Anjani returned a delivery run without a time');
  const reason = text(row, 'reason_name', 120);
  const description = DELIVERED.test(reason) ? 'Delivered' : reason || 'Out For Delivery';
  const location = text(row, 'from_center_name', 120);
  const staged = shreeAnjaniDeliveryStage(description);
  return { at: at.toMillis(), rank: 1, event: {
    time: indian(at),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The booking: a day at the booking centre, or an instant should the reply give one. */
function projectBooking(booking: Record<string, unknown>): CarrierEvent | null {
  const value = booking.booking_date;
  if (value === null || value === undefined || value === '') return null;
  const day = typeof value === 'string' ? DAY.exec(value)?.[1] : undefined;
  if (day && !DateTime.fromISO(day, { zone: 'utc' }).isValid) throw new SchemaError(PROVIDER, 'Shree Anjani returned an invalid booking_date');
  const at = day ? null : instant(booking, 'booking_date');
  const location = text(booking, 'from_center_name', 120);
  const description = 'Booked';
  return { ...(day ? { local_time: day } : { time: indian(at!) }), ...(location ? { location } : {}), description,
    stage: shreeAnjaniWordingStage(description)!, stage_source: 'carrier_map' };
}

/**
 * The reply of `GET /public/awb/{number}`: the booking, the hub and branch
 * scans and the delivery run sheets, each with its own clock. An unknown number
 * is a booking that only echoes the number, without a date or scans. Scans
 * under such a booking, or under none, are stray scans no one booked.
 */
export function parseShreeAnjani(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShreeAnjaniNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Shree Anjani returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Shree Anjani did not complete the lookup');
  const data = payload.item ?? payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Shree Anjani returned an invalid shipment');
  const booking = data.booking ?? null;
  if (booking !== null && !isRecord(booking)) throw new SchemaError(PROVIDER, 'Shree Anjani returned an invalid booking');
  // The booking echoes the number asked, even an unknown one.
  if (booking && cleanScalar(booking.barcode_number, 64) !== number) {
    throw new IndeterminateError(PROVIDER, 'Shree Anjani answered for another shipment');
  }
  const scans = rows(data, 'booking_tracking');
  const runs = rows(data, 'drs_list');
  const booked = booking ? projectBooking(booking) : null;
  const status = booking ? text(booking, 'status_name', 120) : '';
  if (!booked && !status) {
    if (!scans.length && !runs.length && booking) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Shree Anjani has scans but no booking for the number');
  }

  const seen = new Set<string>();
  const dated: Scan[] = [];
  for (const scan of [...scans.map(projectScan), ...runs.map(projectRun)]) {
    const key = JSON.stringify([scan.event.time, scan.event.provider_code, scan.event.description, scan.event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    dated.push(scan);
  }
  // Newest first; a run sheet after the scans of its moment, and the booking day last.
  const events = dated.sort((a, b) => b.at - a.at || b.rank - a.rank).map((scan) => scan.event);
  if (booked) events.push(booked);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const reason = text(booking!, 'reason_name', 60);
  // The booking's status decides a delivery; otherwise the newest staged scan does.
  const summary: Stage | undefined = DELIVERED.test(reason) || DELIVERED.test(status) ? 'delivered' : undefined;
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const settled = instant(booking!, 'status_date');
  const delivered = stage !== 'delivered' ? undefined
    : summary && settled ? indian(settled) : events.find((event) => event.stage === 'delivered' && event.time)?.time;
  const headline = DELIVERED.test(status) ? status.replace(RECEIVER, '') : status;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: headline || newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
