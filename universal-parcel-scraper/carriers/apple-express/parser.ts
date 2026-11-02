import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { appleExpressStage, appleExpressStateStage, isAppleExpressNotice } from './status.js';

export const PROVIDER = 'Apple Express';
// A long history is a few kilobytes.
export const APPLE_EXPRESS_MAX_BYTES = 256 * 1024;
// Apple Express's own order numbers, a sequence: eight digits, and nine once it outgrows eight.
const ORDER = /^\d{8,9}$/;
// The references the tracker also opens: a shipper's APPL reference, and Cainiao's for marketplace parcels.
const REFERENCE = /^(?:APPL\d{13}|CACAINIAO\d{11})$/;
// A wall clock to the second, with the fraction of a second some rows add.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The zones a row can name beside its clock, as Apple Express abbreviates them.
const ZONES: Readonly<Record<string, string>> = { ET: 'America/Toronto', PT: 'America/Vancouver' };
// The estimate the summary gives, as "Estimated Delivery: July 3, 2026 9:00 PM".
const ESTIMATE = /^Estimated Delivery:\s*([A-Z][a-z]+ \d{1,2}, \d{4})(?:\s+\d{1,2}:\d{2}\s*[AP]M)?$/;
// A digit in a place could be a street number or a postcode; rows name a depot's town and province.
const ADDRESS = /\d/;
const MAX_ORDERS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

export interface AppleExpressNumber {
  readonly number: string;
  /** An order number is looked up directly; a reference through the orders it names. */
  readonly kind: 'order' | 'reference';
}

/** An Apple Express order number or a reference its tracker opens, in capitals; anything else is not one it tracks. */
export function normalizeAppleExpressNumber(raw: string): AppleExpressNumber {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (ORDER.test(number)) return { number, kind: 'order' };
  if (REFERENCE.test(number)) return { number, kind: 'reference' };
  throw new InvalidInputError(PROVIDER, 'Apple Express tracks eight-digit order numbers, APPL references and Cainiao references');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Apple Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An order's number, which the replies give as a string of digits. */
function orderNumber(row: Record<string, unknown>): string {
  const value = text(row, 'appleTrackingNumber', 32);
  if (!/^\d{1,16}$/.test(value)) throw new SchemaError(PROVIDER, 'Apple Express returned an order without its number');
  return value;
}

/**
 * The order the reply of `trackmultiple/{reference}` names for a reference: the
 * orders whose reference it is, each with its number. An empty list is the
 * page's not-found. Several orders under one reference leave the parcel
 * undecided, and so does a list that names none under the whole reference.
 */
export function appleExpressOrderFor(payload: unknown, reference: string): string {
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid order list');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ORDERS) throw new IndeterminateError(PROVIDER, 'Apple Express names many orders for the reference');
  const orders = new Set<string>();
  for (const row of payload) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid order list');
    const number = orderNumber(row);
    if (text(row, 'reference', 64).toUpperCase() === reference) orders.add(number);
  }
  if (!orders.size) throw new IndeterminateError(PROVIDER, 'Apple Express answered for other orders');
  if (orders.size > 1) throw new IndeterminateError(PROVIDER, 'Apple Express names several orders for the reference');
  return [...orders][0]!;
}

type Clock = { time: string } | { local_time: string };

/**
 * A row's clock. `generatedAt` is a wall clock without an offset. Most rows name no
 * zone, and within one history they keep different ones, a depot's or the head
 * office's, so they stay local. A row that names its zone, as `ET`, is an instant.
 */
function scanClock(row: Record<string, unknown>): Clock {
  const raw = text(row, 'generatedAt', 40);
  const match = CLOCK.exec(raw);
  const wall = match?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Apple Express returned an invalid scan time');
  }
  const zone = ZONES[text(row, 'generatedAtTimeZone', 16).toUpperCase()];
  if (!zone) return { local_time: wall };
  const time = firstOccurrence(DateTime.fromISO(wall, { zone })).toISO({ suppressMilliseconds: true });
  if (!time) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid scan time');
  return { time };
}

interface Row {
  readonly key: string;
  readonly event: CarrierEvent;
  readonly notice: boolean;
}

function projectRow(row: Record<string, unknown>): Row {
  const description = text(row, 'status');
  if (!description) throw new SchemaError(PROVIDER, 'Apple Express returned a status without wording');
  const clock = scanClock(row);
  const place = text(row, 'location', 120);
  const location = place && !ADDRESS.test(place) ? place : '';
  const staged = appleExpressStage(description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const when = 'time' in clock ? clock.time : clock.local_time;
  return { key: JSON.stringify([when, description, location]), event, notice: isAppleExpressNotice(description) };
}

/** The estimate's day; "To Be Determined" and a delivered parcel's delivery time are none. */
function estimate(change: string): string | null {
  const match = ESTIMATE.exec(change);
  if (!match) return null;
  const day = DateTime.fromFormat(match[1]!, 'MMMM d, yyyy', { locale: 'en-US', zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

/** The order's state number, when the reply gives one. */
function stateOf(order: Record<string, unknown>): number | null {
  const value = order.statusId;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid status number');
  return value;
}

/**
 * The reply of the tracking page's `order/{number}/language/en`: the order's summary
 * and its status rows, newest first. A number it does not know is HTTP 200 with every
 * part null, which the page reports as not found. The order must be the one asked:
 * its own number for an order number; for a reference, that reference and the order
 * the order list named for it. The pickup and delivery towns, the delivery options,
 * a cancellation's name and reason and the proof of delivery are not read.
 */
export function parseAppleExpress(payload: unknown, raw: string, listedOrder?: string): CarrierResult {
  const asked = normalizeAppleExpressNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'orderDetails')) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid reply');
  const order = payload.orderDetails;
  if (order === null) {
    if (payload.statusDetails !== null && payload.statusDetails !== undefined) throw new SchemaError(PROVIDER, 'Apple Express returned scans without an order');
    throw new NotFoundError(PROVIDER);
  }
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid order');
  const own = orderNumber(order);
  const reference = text(order, 'reference', 64).toUpperCase();
  const bound = asked.kind === 'order' ? own === asked.number
    : reference === asked.number && (listedOrder === undefined || own === listedOrder);
  if (!bound) throw new IndeterminateError(PROVIDER, 'Apple Express answered for another order');
  const rows = payload.statusDetails ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Apple Express returned an order with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Apple Express returned an oversized history');

  const seen = new Set<string>();
  const projected: Row[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Apple Express returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    projected.push(scan);
  }
  if (!projected.length) throw new NoHistoryError(PROVIDER);
  // The page lists the rows in the reply's order, newest first. Their clocks are kept in
  // different zones, so the order stands rather than a sort by wall clock. A notice keeps
  // the stage of the scan before it, so the shared rules do not read one into it.
  let previous: Stage | undefined;
  for (const { event, notice } of [...projected].reverse()) {
    if (notice) Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
    else if (event.stage) previous = event.stage as Stage;
  }
  const events = projected.map(({ event }) => event);

  const newest = events[0]!;
  const scanned = projected.find(({ event, notice }) => !notice && event.stage)?.event;
  const current = text(order, 'currentStatus', 120);
  const change = text(order, 'statusChangeText', 80);
  const state = stateOf(order);
  const summary = (state === null ? undefined : appleExpressStateStage(state))
    ?? (current && !isAppleExpressNotice(current) ? appleExpressStage(current)?.stage : undefined);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(change);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: current || newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: expected,
    ...(asked.kind === 'reference' ? { canonical_tracking_number: own } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
