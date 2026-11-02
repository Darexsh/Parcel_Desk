import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { quiqupStage, quiqupWording } from './status.js';

export const PROVIDER = 'Quiqup';
// A long history is a few kilobytes.
export const QUIQUP_MAX_BYTES = 256 * 1024;
// Quiqup's order numbers, a sequence without leading zeros: seven digits on older orders, eight now.
const NUMBER = /^[1-9]\d{6,7}$/;
// An ISO time with its offset, as the reply writes every clock.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const STATE = /^[a-z][a-z0-9_]{0,39}$/;
// The page promises no time once the order is delivered, returned, stopped or missed.
const NO_ESTIMATE: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception', 'failed_attempt']);
// A customer's return the courier collects, whose estimate the page works out differently.
const RETURN_COLLECTION = 'partner_return';
const DELIVERED = 'delivery_complete';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Quiqup order number: its digits, without a leading zero; anything else is not one Quiqup issues. */
export function normalizeQuiqupNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Quiqup order numbers are seven or eight digits without a leading zero');
  return number;
}

/** A state name, or nothing; anything but a plain name is a changed reply. */
function state(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || !STATE.test(value)) throw new SchemaError(PROVIDER, `Quiqup returned an invalid ${key}`);
  return value;
}

/** A clock with its offset, or null when the reply has none that reads. */
function instant(value: unknown): { iso: string; timestamp: number } | null {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  return explicitOffsetTime(value);
}

/** The order's own number, which the reply gives as an integer. */
function orderNumber(order: Record<string, unknown>): string {
  const value = order.id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,16}$/.test(value.trim())) return value.trim();
  throw new SchemaError(PROVIDER, 'Quiqup returned an order without its number');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly timestamp: number;
  readonly state: string;
}

function projectRow(row: Record<string, unknown>): { key: string; scan: Scan } {
  const code = state(row, 'to_state');
  if (!code) throw new SchemaError(PROVIDER, 'Quiqup returned a state change without its state');
  const time = instant(row.occurred_at);
  if (!time) throw new SchemaError(PROVIDER, 'Quiqup returned an invalid state change time');
  const staged = quiqupStage(code);
  const event: CarrierEvent = {
    time: time.iso,
    description: quiqupWording(code),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.timestamp, code]), scan: { event, timestamp: time.timestamp, state: code } };
}

/**
 * The reply of the tracking page's `GET /order_management/tracking` for an
 * order number: the order with its current state, the time the order entered
 * each state, oldest first, and the time it is due by. An unknown number is
 * HTTP 422, which the adapter reads before this. The order must be the one
 * asked. The merchant's own order number, the live mission and a robot
 * delivery's details are not read; the reply to a number alone has no
 * address, contact or payment.
 */
export function parseQuiqup(payload: unknown, raw: string): CarrierResult {
  const number = normalizeQuiqupNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Quiqup returned an invalid reply');
  const order = payload.order;
  if (order === null || order === undefined) {
    // The page follows such a reply to another page, which the adapter does not read.
    if (payload.trackingUrl || payload.tracking_url) throw new IndeterminateError(PROVIDER, 'Quiqup sent the lookup to another tracking page');
    throw new SchemaError(PROVIDER, 'Quiqup returned a reply without an order');
  }
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'Quiqup returned an invalid order');
  if (orderNumber(order) !== number) throw new IndeterminateError(PROVIDER, 'Quiqup answered for another order');
  const rows = order.state_changes ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Quiqup returned an order with invalid state changes');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quiqup returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Quiqup returned an invalid state change');
    const { key, scan } = projectRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page sorts them; within a second the reply's order, turned round when it lists the oldest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The order's current state, which a state change at the same second cannot hide.
  const current = state(order, 'state');
  const summary = current ? quiqupStage(current) : null;
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary?.source ?? scanned?.stage_source;
  const delivery = stage === 'delivered' ? scans.find((scan) => scan.state === DELIVERED)?.event.time : undefined;
  const window = isRecord(order.delivery_time) ? order.delivery_time : {};
  const due = !stage || NO_ESTIMATE.has(stage) || clean(order.service_kind, 40) === RETURN_COLLECTION
    ? null : instant(window.delivery_before);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: due?.iso ?? null,
    ...(delivery ? { delivered_at: delivery } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
