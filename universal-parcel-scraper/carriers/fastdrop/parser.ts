import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { EXPLICIT_OFFSET_PATTERN, explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fastdropStatusLabel, fastdropStatusStage, fastdropWordingStage } from './status.js';

export const PROVIDER = 'Fastdrop';
// A long journey is a few kilobytes.
export const FASTDROP_MAX_BYTES = 256 * 1024;
// MotionTools' tracking codes are ten digits.
const NUMBER = /^\d{10}$/;
const STATUS = /^[a-z_]{1,40}$/;
// A wall clock without an offset, to the second; a fraction of a second is dropped.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/;
const ZONE = 'Europe/Malta';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Fastdrop's tracker, ten digits; anything else is not one it issues. */
export function normalizeFastdropNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fastdrop tracking IDs are ten digits');
  return number;
}

/** Whether the reply's tracking code is the number asked; the platform documents it as a string with a numeric example. */
function sameNumber(value: string | number, number: string): boolean {
  if (typeof value === 'number') return String(value).padStart(10, '0') === number;
  return value.length <= 64 && normalizeTrackingNumber(value) === number;
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** A failed stop's reason, the title of one of the reasons the operator configures, without phone numbers. */
function reason(stop: Record<string, unknown>): string {
  const failure = stop.failure_reason;
  if (failure === null || failure === undefined) return '';
  if (!isRecord(failure) || typeof failure.title !== 'string') throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid failure reason');
  return clean(failure.title.replace(PHONE, ''), 120).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The tracking page's wording for a resolved stop: its type, its outcome and whether it is at a hub. */
export function fastdropStopWording(type: 'pickup' | 'dropoff', success: boolean, hub: boolean): string {
  if (type === 'pickup') {
    if (success) return hub ? 'Left the hub' : 'Picked up from the sender';
    return hub ? 'Pickup at the hub failed' : 'Pickup from the sender failed';
  }
  if (success) return hub ? 'Arrived at the hub' : 'Delivered';
  return hub ? 'Drop-off at the hub failed' : 'Delivery failed';
}

/**
 * A stop's clock. `resolved_at` is documented as an ISO 8601 date-time,
 * which carries its offset: that makes an instant. A wall clock without one
 * stays local, and is read in Malta only to order the stops.
 */
function stopClock(value: unknown): { clock: { time: string } | { local_time: string }; at: number } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (parsed && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return { clock: { time: parsed.iso }, at: parsed.timestamp };
  } else {
    const local = WALL_CLOCK.exec(raw)?.[1] ?? '';
    // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
    if (local && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) {
      return { clock: { local_time: local }, at: firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toMillis() };
    }
  }
  throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid stop time');
}

/**
 * The resolved stops of the journey, newest first. A stop whose outcome is
 * still `none` is one the page shows as scheduled, or as the leg under way,
 * and is no scan.
 */
function journey(pkg: Record<string, unknown>): CarrierEvent[] {
  const stops = pkg.journey;
  if (!Array.isArray(stops) || stops.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid journey');
  const seen = new Set<string>();
  const rows: { event: CarrierEvent; at: number }[] = [];
  stops.forEach((stop: unknown) => {
    if (!isRecord(stop) || (stop.type !== 'pickup' && stop.type !== 'dropoff')) throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid stop');
    if (stop.outcome === 'none') return;
    if (stop.outcome !== 'success' && stop.outcome !== 'failure') throw new SchemaError(PROVIDER, 'Fastdrop returned a stop with an invalid outcome');
    const { clock, at } = stopClock(stop.resolved_at);
    const wording = fastdropStopWording(stop.type, stop.outcome === 'success', stop.location_type === 'hub');
    const why = stop.outcome === 'failure' ? reason(stop) : '';
    const description = why ? `${wording}: ${why}` : wording;
    const stage = fastdropWordingStage(normalizeStatusWording(wording));
    const event: CarrierEvent = { ...clock, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ event, at });
  });
  // The platform documents the stops newest first; the clocks decide, and the reply's order breaks a tie.
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  return rows.sort((left, right) => right.at - left.at).map((row) => row.event);
}

/**
 * The stage of the package: its status, which can be newer than any stop.
 * A missed stop takes the failed stop's stage. A package waiting for its
 * next leg after a stop that went through is in transit, not registered.
 */
function currentStage(status: string, events: CarrierEvent[]): Stage | undefined {
  const newest = events[0]?.stage as Stage | undefined;
  if (status === 'failed') return newest === 'failed_attempt' || newest === 'exception' ? newest : 'exception';
  const stage = fastdropStatusStage(status);
  if (!stage) return newest;
  const moved = events.some((event) => event.stage === 'accepted' || event.stage === 'in_transit');
  return stage === 'registered' && moved ? 'in_transit' : stage;
}

/** The delivery estimate the page shows while the package is scheduled for delivery or out for delivery. */
function estimate(pkg: Record<string, unknown>): string | null {
  const eta = pkg.eta;
  if (eta === null || eta === undefined) return null;
  if (!isRecord(eta)) throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid delivery estimate');
  return explicitOffsetTime(eta.expected_arrival_at)?.iso ?? null;
}

/**
 * The reply of `GET /api/hailing/packages/{tracking_code}/tracking` on the
 * MotionTools API, which Fastdrop's tracking page reads: the package's
 * status, its journey of stops and, near delivery, an estimate and the
 * driver's position. The package must name the number asked. Its
 * coordinates, deliberately inexact, and the driver's position are not kept.
 */
export function parseFastdrop(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFastdropNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.package)) throw new SchemaError(PROVIDER, 'Fastdrop returned an invalid envelope');
  const pkg = payload.package;
  const code = pkg.tracking_code;
  if (typeof code !== 'string' && !(typeof code === 'number' && Number.isSafeInteger(code) && code >= 0)) {
    throw new SchemaError(PROVIDER, 'Fastdrop returned a package without its tracking code');
  }
  if (!sameNumber(code, number)) throw new IndeterminateError(PROVIDER, 'Fastdrop answered for another package');
  const status = typeof pkg.status === 'string' ? pkg.status : '';
  if (!STATUS.test(status)) throw new SchemaError(PROVIDER, 'Fastdrop returned a package without its status');
  const events = journey(pkg);
  const stage = currentStage(status, events);
  const newest = events[0];
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: fastdropStatusLabel(status) ?? status,
    ...(events.length ? {} : { provider_code: status, summary_only: true }),
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(pkg),
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
