import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shipbluMappedStage, shipbluStage, shipbluWording } from './status.js';

export const PROVIDER = 'ShipBlu';
// An order with its recipient and a long history is a few kilobytes.
export const SHIPBLU_MAX_BYTES = 256 * 1024;
// The site's tracking box takes seven or more digits starting with 1 to 4.
const NUMBER = /^[1-4]\d{6,39}$/;
const CODE = /^[a-z][a-z_]{0,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// An instant as the service writes it: up to microseconds, and an offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// The scans whose comment the page shows: the reason a courier gives for a missed visit.
const ATTEMPTS = new Set(['delivery_attempted', 'return_attempted']);
// Before pickup the page promises no day: "To be determined after picking up your order".
const BEFORE_PICKUP = new Set(['created', 'pickup_requested', 'pickup_rescheduled']);
// The statuses the page's timeline places on a step of their own; on any
// other, an order on hold shows as such.
const OWN_STEP = new Set(['created', 'pickup_requested', 'pickup_rescheduled', 'out_for_pickup', 'return_requested',
  'picked_up', 'cancelled', 'out_for_delivery', 'out_for_return', 'delivered', 'returned']);
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);
// A run of eight or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

export type ShipbluOrderType = 'delivery-order' | 'return';

/**
 * The tracker's list for a number, by its leading digits as the page routes
 * it: 1 and 31 are delivery orders, 2 and 32 returns.
 */
export function shipbluOrderType(number: string): ShipbluOrderType | undefined {
  if (/^(?:1|31)/.test(number)) return 'delivery-order';
  if (/^(?:2|32)/.test(number)) return 'return';
  return undefined;
}

/** A ShipBlu number for a parcel, as its digits; anything else is not one ShipBlu issues for a parcel. */
export function normalizeShipbluNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ShipBlu numbers are seven or more digits starting with 1 to 4');
  // The page looks numbers starting with 4 up as cash collections, which carry no parcel,
  // and has no list for one starting with 3 then another digit than 1 or 2.
  if (!shipbluOrderType(number)) throw new InvalidInputError(PROVIDER, 'ShipBlu tracks parcels under numbers starting with 1, 2, 31 or 32');
  return number;
}

/** An instant the reply states with its offset. */
function instant(value: unknown): { iso: string; timestamp: number } | null {
  return typeof value === 'string' && INSTANT.test(value.trim()) ? explicitOffsetTime(value) : null;
}

/** A calendar day, or nothing. */
function day(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY.test(value.trim())) return null;
  return DateTime.fromISO(value.trim(), { zone: 'UTC' }).isValid ? value.trim() : null;
}

/** A status code, in the lower case the service writes. */
function statusCode(row: Record<string, unknown>): string {
  const code = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'ShipBlu returned an invalid status');
  return code;
}

/** A missed visit's reason, without phone numbers. */
function reason(row: Record<string, unknown>): string {
  const value = row.comment;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'ShipBlu returned an invalid comment');
  return clean(value.replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly timestamp: number;
}

function projectRow(row: Record<string, unknown>): { key: string; scan: Scan } {
  const code = statusCode(row);
  const time = instant(row.created);
  if (!time) throw new SchemaError(PROVIDER, 'ShipBlu returned an invalid scan time');
  const why = ATTEMPTS.has(code) ? reason(row) : '';
  const description = why ? `${shipbluWording(code)}: ${why}` : shipbluWording(code);
  const staged = shipbluStage(code);
  const event: CarrierEvent = {
    time: time.iso,
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.timestamp, code, why]), scan: { event, timestamp: time.timestamp } };
}

/**
 * The day the page promises: none before pickup or once the order ended, else
 * the day the customer chose, else for a return the service's estimate. The
 * page asks another endpoint for a delivery order's estimate, which this
 * does not read.
 */
function estimate(payload: Record<string, unknown>, type: ShipbluOrderType, current: string, stage: Stage | undefined): string | null {
  if (BEFORE_PICKUP.has(current) || (stage && FINAL.has(stage))) return null;
  return day(payload.preferred_date) ?? (type === 'return' ? day(payload.estimated_date) : null);
}

/**
 * The reply of the tracking page's `GET /api/v1/{delivery-order|return}/{number}/`
 * for one number. An unknown number is HTTP 404, which the adapter reads before
 * this. The reply must name the number asked. It also carries the merchant, the
 * recipient's name, phones and address and the cash to collect, which are never
 * read.
 */
export function parseShipblu(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShipbluNumber(raw);
  const type = shipbluOrderType(number)!;
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'ShipBlu returned an invalid reply');
  if (typeof payload.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'ShipBlu returned an order without its number');
  if (payload.tracking_number.trim() !== number) throw new IndeterminateError(PROVIDER, 'ShipBlu answered for another order');
  const current = statusCode(payload);
  const rows = payload.tracking_events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'ShipBlu returned an order with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ShipBlu returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ShipBlu returned an invalid scan');
    const { key, scan } = projectRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  // Newest first; scans at the same instant keep the reverse of the order they were recorded in.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.map((scan) => scan.event);

  // The page shows an order held for the merchant on the step it waits at.
  const onHold = payload.on_hold !== null && payload.on_hold !== undefined && !OWN_STEP.has(current);
  const summary = onHold ? 'exception' : shipbluMappedStage(current);
  const scanned = events.find((event) => event.stage);
  const stage = summary ?? scanned?.stage as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered'
    ? instant(payload.delivered_date)?.iso ?? events.find((event) => event.provider_code === 'delivered')?.time : undefined;
  const facts = {
    expected_delivery: estimate(payload, type, current, stage),
    ...(delivered ? { delivered_at: delivered } : {}),
  };

  if (!events.length) {
    if (!summary) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(summary), current_stage: summary, current_stage_source: 'carrier_map',
      last_status_text: onHold ? 'On hold' : shipbluWording(current), provider_code: current,
      last_update: delivered ?? null, ...facts, summary_only: true, events: [],
    };
  }
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: onHold ? 'On hold' : newest.description!,
    last_update: newest.time!,
    ...facts,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
