import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lightningExpressLabel, lightningExpressStage } from './status.js';

export const PROVIDER = 'Lightning Express';
// A parcel's reply is under a kilobyte.
export const LIGHTNING_EXPRESS_MAX_BYTES = 64 * 1024;
// Three letters and a two- or three-digit code, then an eight-digit date and a
// four-digit sequence: the tracking field's example has two digits, the order
// list on the business page three.
const NUMBER = /^[A-Z]{3}\d{14,15}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^-?\d{1,3}$/;

/**
 * The milestones the reply stamps, each with the status code whose label the
 * tracking page puts beside its time, in the order the page draws them.
 */
const MILESTONES = [
  ['create_time', '0'],
  ['collect_time', '5'],
  ['receiving_time', '4'],
  ['return_time', '3'],
  ['complete_time', '2'],
] as const;

/** A number for Lightning Express's tracker, in capitals without spaces; anything else is not one it issues. */
export function normalizeLightningExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Lightning Express numbers are three letters and fourteen or fifteen digits');
  }
  return number;
}

/**
 * The number as the tracking page sends it: its script removes every space,
 * then puts one before the last twelve characters and one before the last four.
 */
export function lightningExpressWaybill(raw: string): string {
  const number = normalizeLightningExpressNumber(raw);
  return `${number.slice(0, -12)} ${number.slice(-12, -4)} ${number.slice(-4)}`;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Lightning Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A milestone's wall clock, to the second, or nothing when the parcel has not
 * reached it. The reply names no zone; the clocks are the Toronto depot's.
 */
function wallClock(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value) return null;
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) invalid(`Lightning Express returned an invalid ${key}`);
  return local;
}

/**
 * The reply of the service the tracking page asks, for one number. `code` is
 * `"1"` for a completed lookup, and `data` is `null` for a number the service
 * holds no order under, which the page reports as not found. An order names its
 * number, spaced as the page sends it, its status code and one wall clock for
 * each milestone it reached, the latest when it reached one twice. Every
 * stamped milestone becomes a scan; the status code settles the current stage.
 * The client's name and order number, notes and the delivery and return photos
 * are never read.
 */
export function parseLightningExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLightningExpressNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'code')) invalid('Lightning Express returned an invalid reply');
  if (payload.code !== '1') {
    // The page shows the reply's message for any other code; none has been seen.
    if (typeof payload.code === 'string' || typeof payload.code === 'number') {
      throw new IndeterminateError(PROVIDER, 'Lightning Express did not complete the lookup');
    }
    invalid('Lightning Express returned an invalid reply');
  }
  const data = payload.data;
  if (data === null) throw new NotFoundError(PROVIDER, 'Lightning Express has no order under this number');
  if (!isRecord(data) || typeof data.waybill_sn !== 'string') invalid('Lightning Express returned an order without its number');
  if (normalizeTrackingNumber(clean(data.waybill_sn, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Lightning Express answered for another order');
  }
  const code = cleanScalar(data.status, 8);
  if (!CODE.test(code)) invalid('Lightning Express returned an invalid status');
  const statusName = text(data, 'status_name', 80);

  const events = MILESTONES.flatMap(([key, milestone], rank) => {
    const local = wallClock(data, key);
    if (!local) return [];
    const event: CarrierEvent = {
      local_time: local,
      description: lightningExpressLabel(milestone)!,
      provider_code: milestone,
      stage: lightningExpressStage(milestone)!,
      stage_source: 'carrier_map',
    };
    return [{ local, rank, event }];
  // Newest first; of two milestones at one second, the later one on the page's rail is newer.
  }).sort((a, b) => b.local.localeCompare(a.local) || b.rank - a.rank).map((item) => item.event);

  const newest = events[0];
  const stage = (lightningExpressStage(code) ?? newest?.stage) as Stage | undefined;
  const wording = lightningExpressLabel(code) ?? (statusName || newest?.description);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording ?? null,
    provider_code: code,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
