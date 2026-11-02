import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { exlineStage } from './status.js';

export const PROVIDER = 'Exline';
export const CARRIER = 'exline-kz';
// A long history is a few kilobytes.
export const EXLINE_MAX_BYTES = 256 * 1024;
// Exline's waybill numbers are ten digits.
const NUMBER = /^\d{10}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
const WEIGHT = /^\d{1,6}(?:\.\d{1,3})?$/;
// What the tracker's backend says when MeaSoft has no order under the number.
const NO_ORDER = /^Missing <order> node in tracking response$/;
const MAX_SCANS = 500;

/** A waybill number for Exline's tracker; anything else is not one it issues. */
export function normalizeExlineNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Exline waybill numbers are ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Exline returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A status object, `{code, name, title}`: its code and the wording the page shows, its name, else its title, else its code. */
function statusOf(value: unknown): { code: string; wording: string } {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Exline returned an invalid status');
  const code = text(value, 'code', 40).toUpperCase();
  if (code && !/^[A-Z_]+$/.test(code)) throw new SchemaError(PROVIDER, 'Exline returned an invalid status code');
  const wording = text(value, 'name', 200) || text(value, 'title', 200) || code;
  if (!wording) throw new SchemaError(PROVIDER, 'Exline returned a status without wording');
  return { code, wording };
}

/**
 * A scan's `event_time`, "2026-06-17 14:56:54": the wall clock of the branch
 * that recorded it, as MeaSoft's documentation describes it. The reply names
 * no zone, so the clock stays local.
 */
function wallClock(value: string): string {
  const match = WALL_CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Exline returned an invalid scan time');
  }
  return local;
}

/** The branch and its town, as the page shows them; a town that only repeats the branch is left out. */
function place(store: string, town: string): string {
  if (!town || town === store) return store;
  return store ? `${store}, ${town}` : town;
}

interface Scan { event: CarrierEvent; index: number }

/**
 * A scan's clock, branch, town and status. Its `message` is left out: it
 * names the branch a transfer goes to, and on the delivery the day and the
 * person who took the parcel.
 */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Exline returned an invalid scan');
  const { code, wording } = statusOf(row.status);
  const local = wallClock(text(row, 'event_time', 32));
  const location = place(text(row, 'event_store', 120), text(row, 'event_town', 120));
  const staged = exlineStage(code, wording);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description: wording,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, index };
}

/** The planned delivery day, `receiver_date`; anything but a calendar day is no estimate. */
function plannedDay(data: Record<string, unknown>): string | null {
  const day = DAY.exec(text(data, 'receiver_date', 32))?.[1];
  if (!day || day < '2000-01-01') return null;
  return DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/** The weight in kilograms, which the page shows with "kg"; zero or another shape is none. */
function weight(data: Record<string, unknown>): number | null {
  const value = data.weight;
  const raw = typeof value === 'number' ? String(value) : text(data, 'weight', 16);
  if (!WEIGHT.test(raw)) return null;
  const kilograms = Number(raw);
  return kilograms > 0 ? kilograms : null;
}

/**
 * The error body of the tracker's lookup, which comes with HTTP 502. MeaSoft
 * answering without an order is the page's "not found"; any other error is a
 * failure of the backend, not a missing parcel.
 */
export function readExlineError(payload: unknown): never {
  if (!isRecord(payload) || !isRecord(payload.error)) throw new IndeterminateError(PROVIDER, 'Exline did not complete the lookup');
  const code = typeof payload.error.code === 'string' ? payload.error.code : '';
  const cause = isRecord(payload.ctx) && typeof payload.ctx.measoft_error === 'string' ? payload.ctx.measoft_error.trim() : '';
  if (code === 'MEASOFT_ERROR' && NO_ORDER.test(cause)) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Exline’s tracking system did not complete the lookup');
}

/**
 * The reply of the tracking page's `POST /api/v1/track/detail` for one
 * number, which relays MeaSoft's tracking: the order, its current status and
 * its status history in the order MeaSoft recorded it. The order must name
 * the number asked.
 */
export function parseExline(payload: unknown, raw: string): CarrierResult {
  const number = normalizeExlineNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Exline returned an invalid reply');
  if (typeof payload.orderno !== 'string') throw new SchemaError(PROVIDER, 'Exline returned an order without its number');
  if (normalizeTrackingNumber(clean(payload.orderno, 64)) !== number) throw new IndeterminateError(PROVIDER, 'Exline answered for another shipment');
  const current = payload.status === null || payload.status === undefined ? null : statusOf(payload.status);
  const rows = payload.statushistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Exline returned an order with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Exline returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index);
    const identity = JSON.stringify([scan.event.local_time, scan.event.provider_code, scan.event.description, scan.event.location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock, as the page lists them; of two scans in the
  // same second, the one MeaSoft recorded later comes first.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : right.index - left.index);
  const events = scans.map(({ event }) => event);

  // MeaSoft's current status is the order's state, even when an operator's
  // correction leaves it behind a later scan.
  const summary = current ? exlineStage(current.code, current.wording) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary ? summary.source : scanned?.stage_source;
  const latest = events[0]!;
  const kilograms = weight(payload);
  const planned = plannedDay(payload);
  const expected = stage === 'delivered' || stage === 'returned' ? null : planned;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: expected,
    ...(kilograms !== null ? { weight_kg: kilograms } : {}),
    events,
  };
}
