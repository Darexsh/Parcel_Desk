import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pathaoStage } from './status.js';

export const PROVIDER = 'Pathao Courier';
// A long history is a few kilobytes.
export const PATHAO_MAX_BYTES = 256 * 1024;
// `pathao-courier-1`'s layout: D, a letter, the creation day, month and
// two-digit year, and six letters and digits.
const NUMBER = /^D[A-Z](?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}[A-Z0-9]{6}$/;
// Bangladesh's one zone, which the service writes every clock in.
const ZONE = 'Asia/Dhaka';
const CLOCK = 'MMM d, yyyy h:mm a';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The estimate: "May 14-15, 2026", "May 31-Jun 1, 2026" or one day.
const ESTIMATE = /^([A-Z][a-z]{2}) (\d{1,2})(?:\s*-\s*(?:([A-Z][a-z]{2}) )?(\d{1,2}))?, (\d{4})$/;

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Whoever a scan assigns the parcel to, up to what for: "Assigned to … for delivery".
const ASSIGNEE = /\b(assigned)\s+to\b[\s\S]*?(?=\s+for\b|$)/gi;
// The rider in brackets after the word for one: "Our Deliver man (…) has picked-up …".
const RIDER = /\b(deliver(?:y)?\s*man|rider|agent)\s*\((?:[^()]|\([^()]*\))*\)/gi;

/** A Pathao consignment ID, in capitals; anything else is not one Pathao issues. */
export function normalizePathaoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Pathao consignment IDs are D, a letter, a date and six letters and digits');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pathao returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wording without the rider it names or any phone number:
 * "Assigned to … (…) for delivery." becomes "Assigned for delivery.".
 */
export function pathaoWording(description: string): string {
  return clean(description.replace(ASSIGNEE, '$1').replace(RIDER, '$1').replace(PHONE, '')
    .replace(/\(\s*[-–]?\s*\)/g, '').replace(/\s+([,.;:])/g, '$1'))
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** The step the scan is filed under: the first entry of `grouped_status`, when the reply has one. */
function groupOf(row: Record<string, unknown>): string {
  const group = row.grouped_status;
  if (group === null || group === undefined) return '';
  if (!Array.isArray(group) || (group[0] !== undefined && typeof group[0] !== 'string')) {
    throw new SchemaError(PROVIDER, 'Pathao returned an invalid scan step');
  }
  return clean(group[0], 40);
}

function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } | null {
  const description = pathaoWording(text(row, 'desc', 500));
  const parsed = zonedTime(text(row, 'created_at', 40), CLOCK, ZONE, { locale: 'en-US' });
  if (!parsed) throw new SchemaError(PROVIDER, 'Pathao returned an invalid scan time');
  const code = groupOf(row);
  if (!description) return null;
  const staged = pathaoStage(code, description);
  const event: CarrierEvent = {
    time: parsed.iso,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([parsed.timestamp, code, description]), timestamp: parsed.timestamp, event };
}

/** The tracking page's rail, for a parcel that ended its journey: delivered or sent back. */
function summaryStage(data: Record<string, unknown>): Stage | undefined {
  const state = data.state;
  if (state === null || state === undefined) return undefined;
  if (!isRecord(state)) throw new SchemaError(PROVIDER, 'Pathao returned an invalid state');
  const name = text(state, 'name', 40).toLowerCase();
  if (name === 'delivered') return 'delivered';
  if (name === 'return' || name === 'paid return' || name === 'returned') return 'returned';
  return undefined;
}

function calendarDay(month: string, day: string, year: number): string | null {
  const parsed = DateTime.fromFormat(`${month} ${day} ${year}`, 'MMM d yyyy', { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/**
 * The delivery estimate, a window of days, for a parcel still on its way. A
 * window that ended before the newest scan's day is stale.
 */
function estimate(order: Record<string, unknown>, stage: Stage | undefined, newest: CarrierEvent)
  : Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (stage === 'delivered' || stage === 'returned' || stage === 'exception') return { expected_delivery: null };
  const match = ESTIMATE.exec(text(order, 'estimated_date', 40));
  if (!match) return { expected_delivery: null };
  const [, month, day, endMonth, endDay, yearText] = match;
  const year = Number(yearText);
  const to = calendarDay(endMonth ?? month!, endDay ?? day!, year);
  let from = calendarDay(month!, day!, year);
  // "Dec 31-Jan 1, 2027" starts in the year before.
  if (from && to && from > to) from = calendarDay(month!, day!, year - 1);
  const newestDay = DateTime.fromISO(newest.time!, { setZone: true }).toISODate();
  if (!from || !to || from > to || (newestDay && to < newestDay)) return { expected_delivery: null };
  return { expected_delivery: to, ...(from < to ? { expected_delivery_from: from } : {}) };
}

/** Whether a reply is Pathao's own answer that it knows no such consignment. */
export function isPathaoNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.type === 'error' && payload.code === 404
    && clean(payload.message, 120).toLowerCase() === 'invalid consignment';
}

/** Pathao's error reply: `{"type":"error","code":404,"message":"Invalid consignment"}` for an unknown ID. */
function refusal(payload: Record<string, unknown>): never {
  if (isPathaoNotFound(payload)) throw new NotFoundError(PROVIDER);
  // Its form check, as "The consignment id must be 14 characters."
  if (payload.code === 422 && isRecord(payload.errors) && Object.hasOwn(payload.errors, 'consignment_id')) {
    throw new InvalidInputError(PROVIDER, 'Pathao does not accept the consignment ID', { reason: 'wrong_number' });
  }
  throw new SchemaError(PROVIDER, 'Pathao returned an unexpected error');
}

/**
 * The reply of the public tracking page's `/api/v1/user/tracking` for one
 * consignment ID. The order must name the ID asked. Staff notes, the rider,
 * the merchant, the contents, the amounts to collect and the delivery hub's
 * position are never read; the recipient's details come only with their phone
 * number, which is never sent.
 */
export function parsePathaoCourier(payload: unknown, raw: string): CarrierResult {
  const number = normalizePathaoNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Pathao returned an invalid envelope');
  if (payload.type === 'error') refusal(payload);
  if (payload.type !== 'success' || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Pathao returned an invalid envelope');
  const data = payload.data;
  const order = data.order;
  if (!isRecord(order) || typeof order.consignment !== 'string') throw new SchemaError(PROVIDER, 'Pathao returned an order without its consignment ID');
  if (normalizeTrackingNumber(clean(order.consignment, 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Pathao answered for another consignment');
  }
  const rows = data.log ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Pathao returned an order with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pathao returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pathao returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans in the same minute keep the reply's order, oldest first.
  const events = scans.reverse().sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = summaryStage(data);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...estimate(order, stage, newest),
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
