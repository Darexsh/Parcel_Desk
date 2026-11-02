import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bjsStage } from './status.js';

export const PROVIDER = 'BJS Home Delivery';
// A reply is a few hundred bytes.
export const BJS_MAX_BYTES = 64 * 1024;
const ZONE = 'Europe/London';
// B, seven digits and four more, which BJS prints after a dash.
const NUMBER = /^B(\d{7})(\d{4})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MAX_ROWS = 50;
// The tracker's own answer to a reference it holds no order for.
const NOT_FOUND = /^Bad request\. 'Orders' not found$/i;

/** A BJS consignment number, without its dash; anything else is not one BJS issues. */
export function normalizeBjsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BJS consignment numbers are B and eleven digits');
  return number;
}

/** The number as BJS prints it and its tracker sends it: B, seven digits, a dash and four digits. */
export function printedBjsNumber(raw: string): string {
  const [, head, tail] = NUMBER.exec(normalizeBjsNumber(raw))!;
  return `B${head}-${tail}`;
}

/** A row's text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `BJS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The row's day, as the page prints it (`23/06/2026`), or empty when it has none. */
function dayOf(row: Record<string, unknown>): string {
  const value = text(row, 'timestamp', 40);
  if (!value) return '';
  const match = DAY.exec(value);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'BJS returned an invalid status date');
  return day;
}

/**
 * The reply of the mini tracker's `website/mini_track` lookup: one row per
 * consignment the reference finds, with its current status and a day the page
 * labels "Timestamp". Only the row of the whole consignment asked counts. An
 * unknown reference is `success: false` with the tracker's "'Orders' not
 * found"; `now` dates the lookup in the UK.
 */
export function parseBjs(payload: unknown, raw: string, now: number): CarrierResult {
  const number = normalizeBjsNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'BJS returned an invalid envelope');
  if (!payload.success) {
    if (NOT_FOUND.test(clean(payload.message, 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'BJS did not complete the lookup');
  }
  const rows = payload.result;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'BJS returned an invalid order list');
  const matches = new Map<string, { status: string; day: string }>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.consignment !== 'string') throw new SchemaError(PROVIDER, 'BJS returned an order without its consignment');
    // The reference also finds an order's other consignments; only the one asked counts.
    if (normalizeTrackingNumber(row.consignment) !== number) continue;
    const status = text(row, 'status', 80);
    if (!status) throw new SchemaError(PROVIDER, 'BJS returned an order without its status');
    const day = dayOf(row);
    matches.set(JSON.stringify([status, day]), { status, day });
  }
  if (!matches.size) throw new IndeterminateError(PROVIDER, rows.length ? 'BJS answered for another consignment' : 'BJS returned no order');
  if (matches.size > 1) throw new IndeterminateError(PROVIDER, 'BJS returned several orders for the consignment');
  const [{ status, day: printed }] = [...matches.values()] as [{ status: string; day: string }];

  // The day is the status's own. One after today's date in the UK is no status's
  // day, such as a booked delivery, and the page does not say what it is.
  const today = DateTime.fromMillis(now, { zone: ZONE }).toISODate()!;
  const day = printed && printed <= today ? printed : '';
  const staged = bjsStage(status);
  const events: CarrierEvent[] = day
    ? [{ local_time: day, description: status, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) }]
    : [];
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: status,
    last_update: null,
    ...(day ? { last_update_local: day } : {}),
    expected_delivery: null,
    summary_only: true,
    events,
  };
}
