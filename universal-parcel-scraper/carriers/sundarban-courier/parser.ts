import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { SUNDARBAN_CODES, sundarbanStage } from './status.js';

export const PROVIDER = 'Sundarban Courier';
// A shipment with its history is about five kilobytes.
export const SUNDARBAN_MAX_BYTES = 512 * 1024;
// A CN number, or a sub-CN: fourteen or seventeen digits.
const NUMBER = /^\d{14}(?:\d{3})?$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
const MAX_ENTRIES = 50;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A CN number for Sundarban's tracker; anything else is not one Sundarban issues. */
export function normalizeSundarbanNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sundarban CN numbers are fourteen digits, or seventeen for a sub-CN');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Sundarban returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A `statusDate`, "2026-08-04T00:00:00": the branch's wall clock with no zone.
 * The service keeps the day only and writes it at midnight, so a clock at
 * midnight exactly keeps only its day.
 */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new SchemaError(PROVIDER, 'Sundarban returned an invalid status date');
  }
  return `${match[4]}${match[5]}${match[6]}` === '000000' ? day : `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

/** A status as the page labels it: an international code by its label, a domestic status as written. */
function statusOf(status: string): { description: string; code: string | null } {
  return Object.hasOwn(SUNDARBAN_CODES, status) ? { description: SUNDARBAN_CODES[status]!.label, code: status } : { description: status, code: null };
}

/**
 * A row of `cnStatusList`: its status, day and the branch it happened at. The
 * branch it was sent towards, the vehicle, the bag or manifest number and the
 * remarks are not kept. A row without a status is left out.
 */
function scanOf(row: unknown): CarrierEvent | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Sundarban returned an invalid status row');
  const status = text(row, 'status', 120);
  const local = wallClock(text(row, 'statusDate', 40));
  if (!status) return null;
  const { description, code } = statusOf(status);
  const location = text(row, 'fromSubBranch', 120);
  const staged = sundarbanStage(code, status);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The shipment's statuses, newest first. The service lists them oldest first. */
function history(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.cnStatusList ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Sundarban returned a shipment with an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Sundarban returned an oversized history');
  const scans = rows.map((row, index) => ({ event: scanOf(row), index }))
    .filter((scan): scan is { event: CarrierEvent; index: number } => scan.event !== null);
  // A day without a clock sorts before that day's clocks; within one, the later row is newer.
  return scans.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.index - a.index)
    .map(({ event }) => event);
}

/**
 * The branch counter the parcel waits at, or was collected from: the page's
 * "Ready for C/D" names it, when nothing but a delivery followed.
 */
function counter(events: CarrierEvent[]): string | undefined {
  const [newest, before] = events;
  const ready = newest?.stage === 'ready_for_pickup' ? newest : newest?.stage === 'delivered' && before?.stage === 'ready_for_pickup' ? before : undefined;
  return ready?.location;
}

/** The shipment's current status alone, when the service lists no history for it. */
function summary(shipment: Record<string, unknown>): CarrierResult {
  const status = text(shipment, 'status', 120);
  if (!status) throw new NoHistoryError(PROVIDER);
  const { description, code } = statusOf(status);
  const staged = sundarbanStage(code, status);
  const date = text(shipment, 'statusDate', 40);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: description,
    ...(code ? { provider_code: code } : {}),
    last_update: null,
    ...(date ? { last_update_local: wallClock(date) } : {}),
    summary_only: true,
    events: [],
  };
}

function project(shipment: Record<string, unknown>): CarrierResult {
  const events = history(shipment);
  if (!events.length) return summary(shipment);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const point = counter(events);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the tracking page's lookup, `POST /Home/getDatabyCN`: a list of
 * the shipments under the CN number, each naming its `cnNumber`. For a number
 * it holds nothing for, the list is empty and the page only says an error
 * occurred and asks for the correct format, so that answer is inconclusive.
 */
export function parseSundarban(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSundarbanNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Sundarban returned an invalid reply');
  if (payload.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Sundarban returned too many shipments');
  if (!payload.length) {
    throw new IndeterminateError(PROVIDER, 'Sundarban\'s tracker shows nothing for the number', { reason: 'portal_not_found' });
  }
  const shipments = payload.filter((entry) => {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'Sundarban returned an invalid shipment');
    const own = text(entry, 'cnNumber', 64);
    if (!own) throw new SchemaError(PROVIDER, 'Sundarban returned a shipment without its CN number');
    return normalizeTrackingNumber(own) === number;
  }) as Record<string, unknown>[];
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Sundarban returned several shipments under the number');
  if (!shipments.length) throw new IndeterminateError(PROVIDER, 'Sundarban answered for another shipment');
  return project(shipments[0]!);
}
