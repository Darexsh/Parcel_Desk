import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isHiddenShreeMarutiCode, shreeMarutiCode, shreeMarutiReading } from './status.js';

export const PROVIDER = 'Shree Maruti';
// A long history is a few tens of kilobytes.
export const SHREE_MARUTI_MAX_BYTES = 1024 * 1024;
const ZONE = 'Asia/Kolkata';
// Twelve or thirteen digits on the former tracker, fourteen on recent dockets.
const NUMBER = /^\d{12,14}$/;
// Scan clocks are epoch milliseconds; anything outside these years is a changed reply.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
// A row the service stored this close to its own clock was recorded as it
// happened: a little before it, as a fast device clock would store it, or up to
// two days after it, as a device syncing late would.
const LIVE_EARLY_MS = 10 * 60_000;
const LIVE_LATE_MS = 2 * 24 * 3_600_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The stages whose rows the tracker shows with the reason the courier gave.
const EXPLAINED = new Set<Stage>(['failed_attempt', 'exception', 'returned']);
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** A docket number for Shree Maruti's tracker; anything else is not one it issues. */
export function normalizeShreeMarutiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shree Maruti dockets are twelve to fourteen digits');
  return number;
}

/** Whether a row names the docket asked: its own, the client's or the hub system's number. */
function belongs(row: Record<string, unknown>, number: string): boolean {
  return [row.trackingId, row.cAwbNumber, row.smileAwbNumber].some((value) => cleanScalar(value, 64) === number);
}

/** A row's clock: epoch milliseconds, as a number or digits. */
function clockOf(row: Record<string, unknown>): number {
  const value = row.statusTimestamp;
  const millis = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof millis !== 'number' || !Number.isSafeInteger(millis) || millis < EARLIEST || millis >= LATEST) {
    throw new SchemaError(PROVIDER, 'Shree Maruti returned an invalid scan time');
  }
  return millis;
}

/** When the service stored the row, from its ISO `createdAt`; null without one. */
function storedAt(row: Record<string, unknown>): number | null {
  const value = row.createdAt;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

type ScanClock = { time: string; at: number } | { local_time: string; at: number };

/**
 * A row's time. A row stored as it happened, or without a record time, is an
 * instant, as the tracker shows it. A delivery copied in weeks later holds the
 * Indian wall clock stored as if it were UTC, so a row stored long after its
 * clock, or long before it, keeps those digits as a local clock; its order
 * comes from reading them in India's zone.
 */
function scanTime(clock: number, stored: number | null): ScanClock {
  if (stored === null || (stored - clock >= -LIVE_EARLY_MS && stored - clock <= LIVE_LATE_MS)) {
    return { time: DateTime.fromMillis(clock, { zone: ZONE }).toISO({ suppressMilliseconds: true })!, at: clock };
  }
  const local = DateTime.fromMillis(clock, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  return { local_time: local, at: firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toMillis() };
}

/**
 * A row's place: the hub or branch that scanned it. The row that makes the
 * parcel ready for dispatch names the sender's address instead, and so could an
 * unknown row, so addresses (with commas or a PIN code) and the placeholder
 * `default` are left out.
 */
function scanLocation(row: Record<string, unknown>, code: string): string {
  if (code === 'ready_for_dispatch') return '';
  const place = clean(isRecord(row.location) ? row.location.city : row.location, 120);
  return !place || /^default$/i.test(place) || /,|\d{6}/.test(place) ? '' : place;
}

/** The reason the tracker shows beside an attempt, a hold or a return, when it says more than the status. */
function reasonOf(row: Record<string, unknown>, code: string, stage: Stage | undefined): string {
  if (!stage || !EXPLAINED.has(stage)) return '';
  const reason = clean(cleanScalar(row.event, 200).replace(/_/g, ' ').replace(PHONE, ''), 200)
    .replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, '');
  if (!reason || shreeMarutiCode(reason) === code) return '';
  return reason.charAt(0).toUpperCase() + reason.slice(1).toLowerCase();
}

interface Scan {
  readonly key: string;
  readonly at: number;
  readonly stored: number;
  readonly event: CarrierEvent;
}

function projectRow(row: Record<string, unknown>, courier: boolean): Scan | null {
  const code = shreeMarutiCode(cleanScalar(row.status, 80));
  if (!code) throw new SchemaError(PROVIDER, 'Shree Maruti returned a scan without a status');
  if (isHiddenShreeMarutiCode(code)) return null;
  const category = shreeMarutiCode(cleanScalar(row.category, 80));
  const reading = shreeMarutiReading(code, category, clean(row.subcategory, 200).replace(PHONE, ''));
  // A movement on the way back to the sender is part of the return.
  const returning = reading.movement
    && (clean(row.movement_type, 20).toLowerCase() === 'rto' || category.startsWith('rto') || code.startsWith('rto'));
  const staged = returning ? { stage: 'returned' as Stage, source: 'carrier_map' } : reading.staged;
  // The tracker confirms a courier booking as a shipment rather than an order.
  const label = returning ? 'Return In Transit' : courier && code === 'order_confirmed' ? 'Shipment Confirmed' : reading.label;
  // The tracker gives a reason for the attempt, hold or return itself, not for a movement on the way back.
  const reason = returning ? '' : reasonOf(row, code, staged?.stage);
  const description = reason ? `${label}: ${reason}` : label;
  const clock = clockOf(row);
  const stored = storedAt(row);
  const { at, ...when } = scanTime(clock, stored);
  const location = scanLocation(row, code);
  const event: CarrierEvent = {
    ...when,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([when, code, description, location]), at, stored: stored ?? clock, event };
}

/**
 * The reply of `tracking/v2/{number}`: the order and its rows, newest first.
 * An unknown number is an empty list, or no order and no rows. The order and
 * every row kept must name the number asked.
 */
export function parseShreeMaruti(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShreeMarutiNumber(raw);
  if (Array.isArray(payload)) {
    if (!payload.length) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Shree Maruti returned an unexpected list');
  }
  if (!isRecord(payload) || !Array.isArray(payload.statuses)) throw new SchemaError(PROVIDER, 'Shree Maruti returned an invalid reply');
  const order = payload.orderInformation ?? null;
  if (order !== null && !isRecord(order)) throw new SchemaError(PROVIDER, 'Shree Maruti returned an invalid order');
  if (order && ![order.trackingId, order.cAwbNumber].some((value) => cleanScalar(value, 64) === number)) {
    throw new IndeterminateError(PROVIDER, 'Shree Maruti answered for another shipment');
  }
  const rows: unknown[] = payload.statuses;
  if (!rows.length) {
    if (order) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shree Maruti returned an oversized history');

  const courier = order !== null && clean(order.type, 40).toLowerCase() === 'courier';
  const seen = new Set<string>();
  const scans: Scan[] = [];
  let own = 0;
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Shree Maruti returned an invalid scan');
    // Rows filed under another number are another shipment's.
    if (!belongs(row, number)) continue;
    own += 1;
    const scan = projectRow(row, courier);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!own) throw new IndeterminateError(PROVIDER, 'Shree Maruti answered for another shipment');
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows at the same moment in the order the service stored them.
  const events = scans.sort((a, b) => b.at - a.at || b.stored - a.stored).map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
