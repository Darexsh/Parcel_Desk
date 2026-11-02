import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shipaStage } from './status.js';

export const PROVIDER = 'Shipa';
// A reply is the whole order with its story, under ten kilobytes for thirty statuses.
export const SHIPA_MAX_BYTES = 512 * 1024;
// Shipa Delivery tracking numbers are SD and nine digits; the reply's barcode repeats them.
const NUMBER = /^SD\d{9}$/;
// The service's error code for an order it does not have, sent with "Order not found".
export const ORDER_NOT_FOUND = 50007;
const DELIVERED = '19';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Clocks before 2015 or after 2100 are not Shipa Delivery's.
const EARLIEST = Date.UTC(2015, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

/** A Shipa Delivery tracking number, in capitals; anything else is not one it issues. */
export function normalizeShipaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shipa Delivery tracking numbers are SD and nine digits');
  return number;
}

/** Epoch milliseconds within Shipa Delivery's years, or null. */
function epochMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= EARLIEST && value < LATEST ? value : null;
}

interface Row {
  readonly event: CarrierEvent & { time: string; description: string; provider_code: string };
  readonly timestamp: number;
  readonly index: number;
}

/**
 * One status of the order's story: its code, name, reason, town and clock.
 * `date` is an instant in epoch milliseconds, which the page shows to the
 * second in the visitor's own zone. The courier or hub name, the proof photo,
 * the schedule and the pickup manifest in `details` are never read.
 */
function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Shipa returned an invalid story row');
  const code = cleanScalar(value.statusCode, 16);
  const name = clean(value.status, 120);
  if (!/^\d+$/.test(code) || !name) throw new SchemaError(PROVIDER, 'Shipa returned a story row without its status');
  const at = epochMillis(value.date);
  if (at === null) throw new SchemaError(PROVIDER, 'Shipa returned a story row without its clock');
  const details = value.details ?? null;
  if (details !== null && !isRecord(details)) throw new SchemaError(PROVIDER, 'Shipa returned invalid status details');
  const carrier = details?.carrier;
  // The reason comes from Shipa Delivery's own list, as "Can't reach the Customer - No Answer".
  const reason = clean(details?.failReason, 160).replace(/[\s.]+$/, '');
  const town = isRecord(carrier) ? clean(carrier.city, 80) : '';
  const description = reason ? `${name}: ${reason}` : name;
  const staged = shipaStage(code, name);
  return {
    event: {
      time: DateTime.fromMillis(Math.floor(at / 1000) * 1000, { zone: 'utc' }).toISO({ suppressMilliseconds: true })!,
      description, provider_code: code, ...(town ? { location: town } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    timestamp: at,
    index,
  };
}

/**
 * The day the page gives as the estimated arrival, in the country of the Shipa
 * office handling the order. Like the page, none once the parcel is delivered,
 * nor once it is returned, nor when the day is already behind the newest status.
 */
function estimatedDay(payload: Record<string, unknown>, stage: Stage | undefined, newest: Row | undefined): string | null {
  const eta = epochMillis(payload.dropOffEstimatedTime);
  const zone = countryTimeZone(clean(payload.subsidiaryCountry, 80));
  if (eta === null || !zone || stage === 'delivered' || stage === 'returned') return null;
  const day = DateTime.fromMillis(eta, { zone }).toISODate()!;
  return newest && day < DateTime.fromMillis(newest.timestamp, { zone }).toISODate()! ? null : day;
}

/**
 * The reply of Shipa Delivery's `GET .../services/whl/v2/my-packages/{number}`:
 * the order with its story, oldest first. The order must be the number asked.
 * The pickup and drop-off coordinates, the countries, the driver's location,
 * the vehicle and the support phone number in it are never read.
 */
export function parseShipa(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShipaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Shipa returned an unexpected reply');
  if (payload.code === ORDER_NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (typeof payload.barcode !== 'string') throw new SchemaError(PROVIDER, 'Shipa returned an order without its barcode');
  if (normalizeTrackingNumber(clean(payload.barcode, 64)) !== number) throw new IndeterminateError(PROVIDER, 'Shipa answered for another order');
  const story = payload.orderStory ?? [];
  if (!Array.isArray(story) || story.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shipa returned an invalid story');

  const seen = new Set<string>();
  const rows = (story as unknown[]).map(rowOf).filter((row) => {
    const key = `${row.timestamp}|${row.event.provider_code}|${row.event.description}|${row.event.location ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  // Newest first; of two statuses on one clock, the later in the story is newer.
  }).sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);

  const newest = rows[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  // A follow-up status carries no stage: the status before it still says where the parcel is.
  const current = rows.find((row) => row.event.stage)?.event;
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? rows.find((row) => row.event.provider_code === DELIVERED) : undefined;
  const events = rows.map((row) => row.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.event.description,
    last_update: newest.event.time,
    expected_delivery: estimatedDay(payload, stage, newest),
    ...(delivered ? { delivered_at: delivered.event.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
