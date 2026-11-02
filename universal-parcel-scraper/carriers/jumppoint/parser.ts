import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jumppointLabel, jumppointRemark, jumppointStage } from './status.js';

export const PROVIDER = 'Jumppoint';
// One shipment's reply is under a kilobyte.
export const JUMPPOINT_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Hong_Kong';
// The waybill layout the tracker's own check accepts.
const NUMBER = /^JP\d{12}$/;
const CODE = /^[A-Z][A-Z_]{1,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The replies that carry no reCAPTCHA token or a failed one; the page tells the visitor to try another browser.
const CAPTCHA = new Set(['RESPONSE_TOKEN_MISSING', 'RECAPTHA_VERIFICATION_FAIL', 'RECAPTCHA_VERIFICIATION_PROCESS_ERROR']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Jumppoint waybill number, in upper case as its tracker sends it; anything else is not one it issues. */
export function normalizeJumppointNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jumppoint waybill numbers are JP and twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Jumppoint returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A state code; anything else is a changed reply. */
function state(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 80);
  if (value && !CODE.test(value)) throw new SchemaError(PROVIDER, `Jumppoint returned an invalid ${key}`);
  return value;
}

/** An instant the reply gives in UTC, shown on Hong Kong's clock as the page shows it. */
function instant(value: unknown): { iso: string; timestamp: number } | null {
  const parsed = explicitOffsetTime(value);
  if (!parsed) return null;
  const local = DateTime.fromISO(parsed.iso, { setZone: true }).setZone(ZONE).toISO({ suppressMilliseconds: true });
  return local ? { iso: local, timestamp: parsed.timestamp } : null;
}

function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } {
  const code = state(row, 'status');
  if (!code) throw new SchemaError(PROVIDER, 'Jumppoint returned a status log row without its status');
  const time = instant(row.createdAt);
  if (!time) throw new SchemaError(PROVIDER, 'Jumppoint returned an invalid status log time');
  // Only the reasons the page words itself: free-text remarks can say who signed.
  const remark = jumppointRemark(text(row, 'remarks', 80));
  const description = remark ? `${jumppointLabel(code)}: ${remark}` : jumppointLabel(code);
  const staged = jumppointStage(code, description);
  const event: CarrierEvent = {
    time: time.iso,
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.timestamp, code, description]), timestamp: time.timestamp, event };
}

function history(rows: unknown): CarrierEvent[] {
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Jumppoint returned a shipment with an invalid status log');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jumppoint returned an oversized status log');
  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Jumppoint returned an invalid status log row');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // The log runs oldest first; the result lists the newest first. Rows of one second keep their order.
  return scans.map((scan, index) => ({ ...scan, index }))
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index).map(({ event }) => event);
}

/** The delivery estimate, a calendar day: the reply gives Hong Kong's midnight in UTC. */
function estimate(value: unknown): string | null {
  const raw = clean(value, 40);
  if (!raw) return null;
  if (DATE.test(raw)) return DateTime.fromISO(raw, { zone: 'UTC' }).isValid ? raw : null;
  const time = instant(raw);
  return time ? time.iso.slice(0, 10) : null;
}

/** The pick-up point's name and address, as the page shows them. */
function pickupPoint(shipment: Record<string, unknown>): string {
  const store = shipment.pickUpStoreDetail;
  if (!isRecord(store)) return '';
  const name = clean(store.alias, 120);
  const address = clean(store.address, 300);
  return name ? [name, address].filter(Boolean).join('\n') : '';
}

/** A refusal the reply words itself: a failed reCAPTCHA check, a request it no longer accepts, or its own failure. */
function refusal(error: unknown): never {
  const message = isRecord(error) ? clean(error.user_message, 80) : '';
  const type = isRecord(error) ? clean(error.error_type, 80) : '';
  if (CAPTCHA.has(message)) throw new ChallengeError(PROVIDER, 'Jumppoint asked for a reCAPTCHA token');
  if (type === 'INVALID_PARAM_ERROR') throw new SchemaError(PROVIDER, 'Jumppoint refused the lookup\'s parameters');
  throw new IndeterminateError(PROVIDER, 'Jumppoint did not complete the lookup');
}

/**
 * The reply of `tracking-api.jumppoint.io/shipment/tracking/` for one number.
 * The tracker echoes every number asked; one it has no shipment for comes
 * back without a `shipmentState`, which the page reports as not found.
 */
export function parseJumppoint(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJumppointNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Jumppoint returned an invalid envelope');
  if (!payload.success) refusal(payload.error);
  const trackings = isRecord(payload.data) ? payload.data.trackings : undefined;
  if (!Array.isArray(trackings) || !trackings.length || !trackings.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Jumppoint returned no shipment for the number asked');
  }
  const shipment = trackings.find((row) => clean(row.trackingNumber, 64).toUpperCase() === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Jumppoint answered for another shipment');

  const current = state(shipment, 'shipmentState');
  const events = history(shipment.statusLogs ?? []);
  if (!current) {
    if (events.length) throw new SchemaError(PROVIDER, 'Jumppoint returned a status log without a shipment state');
    throw new NotFoundError(PROVIDER);
  }

  const headed = jumppointStage(current, jumppointLabel(current));
  const scanned = events.find((event) => event.stage);
  // The page heads the shipment with its state. A confirmed waybill nothing has moved yet is registered.
  const stage = (headed?.stage ?? scanned?.stage ?? (current === 'CONFIRMED' ? 'registered' : undefined)) as Stage | undefined;
  const source = headed?.source ?? scanned?.stage_source ?? 'carrier_map';
  const newest = events[0];
  const wording = newest?.provider_code === current ? newest.description! : jumppointLabel(current);
  // A waybill still in its first state was last updated when it was created.
  const updated = newest?.time ?? (current === 'CREATED' ? instant(shipment.createdAt)?.iso : undefined);
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const collected = delivery !== undefined && lastMovement(events.slice(events.indexOf(delivery) + 1)) === 'ready_for_pickup';
  const point = stage === 'ready_for_pickup' || collected ? pickupPoint(shipment) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: wording,
    ...(events.length ? {} : { provider_code: current, summary_only: true }),
    last_update: updated ?? null,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(shipment.deliveryDate),
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
