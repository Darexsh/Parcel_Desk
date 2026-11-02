import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lPostStage } from './status.js';

export const PROVIDER = 'L-POST';
// An order or its history is under two kilobytes.
export const L_POST_MAX_BYTES = 256 * 1024;
// The tracking page's own description of a track number: ABC and eight digits, typed in full.
const NUMBER = /^ABC\d{8}$/;
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;
const PLANNED = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
const CODE = /^[A-Z][A-Z_]{0,39}$/;
const ID = /^\d{1,4}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * An L-POST track number, ABC and eight digits, in capitals. The page also
 * finds an order by the shop's own number, which is not one L-POST issues.
 */
export function normalizeLPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'L-POST track numbers are ABC and eight digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `L-POST returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** What the adapter keeps of the order the tracking page's lookup found. */
export interface LPostOrder {
  /** The track number the order carries, which is the one asked. */
  number: string;
  /** The status's code in L-POST's API classifier, such as `ACT_CREATED`. */
  code: string;
  /** The page's numeric id for the status. */
  id: string;
  /** The status as the page heads the order with it. */
  wording: string;
  /** Brought to the door by a courier rather than collected from a pickup point. */
  courier: boolean;
  /** The planned delivery day. */
  planned: string | null;
  seller: string;
  /** The pickup point's address and directions; empty for a courier delivery, whose address is the recipient's. */
  point: string;
}

/**
 * The reply of `POST /l-backend/tracking` for one number. `error` 3 is the
 * page's "Не удалось найти заказ", and 2 its request for the recipient's
 * phone number. A found order comes as `data`, inside `trackingData` for a
 * pickup point delivery and on its own for a courier one, as the page reads
 * it. The order must carry the number asked as its `OrderNumber`.
 */
export function parseLPostOrder(payload: unknown, raw: string): LPostOrder {
  const number = normalizeLPostNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'error')) throw new SchemaError(PROVIDER, 'L-POST returned an invalid envelope');
  if (payload.error === 3) throw new NotFoundError(PROVIDER);
  if (payload.error === 2) {
    throw new InputRequiredError(PROVIDER, 'recipient verification', 'L-POST asks for the recipient\'s phone number to show this order');
  }
  if (payload.error) throw new IndeterminateError(PROVIDER, 'L-POST did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'L-POST returned an order without its details');
  const order = isRecord(data.trackingData) ? data.trackingData : data;
  if (typeof order.OrderNumber !== 'string') throw new SchemaError(PROVIDER, 'L-POST returned an order without its number');
  if (order.OrderNumber.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'L-POST answered for another order');

  const code = text(order, 'TXT_Status', 40);
  const id = cleanScalar(order.ID_Status, 8);
  const wording = text(order, 'TXT_Status_RU', 200);
  if (!wording || (code && !CODE.test(code)) || (id && !ID.test(id))) throw new SchemaError(PROVIDER, 'L-POST returned an order without its status');
  const courier = cleanScalar(order.isCourier, 4) === '1';
  const planned = PLANNED.exec(text(order, 'DeliveryDatePlan', 32))?.[1];
  const point = courier ? '' : [text(order, 'AdressDelivery'), text(order, 'PickupDopInfo', 200)].filter(Boolean).join('\n');
  return {
    number, code, id, wording, courier,
    planned: planned && DateTime.fromISO(planned, { zone: 'UTC' }).isValid ? planned : null,
    seller: text(order, 'SellerName', 120),
    point,
  };
}

/** A row's wall clock, `dd.MM.yyyy HH:mm`; the reply names no zone. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'L-POST returned an invalid status time');
  }
  return local;
}

/**
 * The reply of `POST /l-backend/tracking/get-order-history` for the order's
 * number: its status changes, newest first. A row of the return classifier,
 * flagged `isVozvratStatus`, keeps its id behind an R.
 */
function history(payload: unknown, courier: boolean): CarrierEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.history) || payload.history.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'L-POST returned an invalid status history');
  }
  const seen = new Set<string>();
  const rows: { event: CarrierEvent; local: string; index: number }[] = [];
  payload.history.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'L-POST returned an invalid status');
    const id = cleanScalar(row.ID_StatusNew, 8);
    const description = text(row, 'txt', 200);
    const flag = row.isVozvratStatus;
    if (!ID.test(id) || !description || (flag !== undefined && flag !== null && typeof flag !== 'boolean')) {
      throw new SchemaError(PROVIDER, 'L-POST returned a status without its id or wording');
    }
    const local = wallClock(row.DateChange);
    const code = flag === true ? `R${id}` : id;
    const staged = lPostStage(code, description, courier);
    const event: CarrierEvent = {
      local_time: local,
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ event, local, index });
  });
  // Newest first; of two rows at one minute, the one the reply lists first is newer.
  return rows.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index).map((row) => row.event);
}

/**
 * The order and its history. The summary's status is the one the page heads
 * the order with, and decides the stage; a status the map leaves without one,
 * such as `ARCHIVE`, gives way to the newest staged row.
 */
export function lPostResult(order: LPostOrder, historyPayload: unknown): CarrierResult {
  const events = history(historyPayload, order.courier);
  const summary = lPostStage(order.code || order.id || null, order.wording, order.courier);
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const done = stage === 'delivered' || stage === 'returned';
  // The point the parcel waits at or was collected from; a pickup point delivery is collected there.
  const point = !order.courier && (stage === 'ready_for_pickup' || stage === 'delivered') ? order.point : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: summary?.source ?? scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: order.wording,
    ...(events.length ? {} : { ...(order.code || order.id ? { provider_code: order.code || order.id } : {}), summary_only: true }),
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: done ? null : order.planned,
    ...(order.seller ? { sender_name: order.seller } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
