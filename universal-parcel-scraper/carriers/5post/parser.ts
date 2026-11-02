import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fivePostStage, fivePostWording } from './status.js';

export const PROVIDER = '5Post';
// A short shop number can list a few dozen orders; an order or its history is a few kilobytes.
export const FIVE_POST_MAX_BYTES = 1024 * 1024;
// A shop's order number in letters and digits, of at least the three the app asks for.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{3,40}$/;
const ORDER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const CODE = /^[A-Z][A-Z\d_]{0,79}$/;
// The warehouse a row names: "Обрабатывается на складе РЦ Казань", "Покинул склад РЦ Казань".
// "Покинул склад. Ожидайте поступления в пункт выдачи" names none.
const WAREHOUSE = /^(?:Обрабатывается на складе|Покинул склад)\s+([^\s.].*)$/u;
const WAREHOUSE_CODES = new Set(['WAREHOUSE_PROCESSING', 'READY_FOR_SHIPMENT']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A 5Post number is the order number the shop gave the parcel, which 5Post
 * matches whole and in upper case. Anything but letters and digits is not one.
 */
export function normalizeFivePostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '5Post numbers are a shop\'s order number of three or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `5Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

const sameNumber = (value: unknown, number: string) => typeof value === 'string' && value.trim().toUpperCase() === number;

/**
 * The order 5Post lists under the whole number, from the reply of
 * `GET /v3/mobile/order-tracking/{number}/orders`. An empty list is the app's
 * "there is no order in the system". Shops choose their own numbers, so two
 * shops' orders can share one; the app then lists both, and the website asks
 * for the recipient's phone digits. Neither can be told apart here.
 */
export function fivePostOrderId(payload: unknown, raw: string): string {
  const number = normalizeFivePostNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, '5Post returned a reply without its order list');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  const ids = new Set<string>();
  for (const order of payload) {
    if (!isRecord(order) || typeof order.orderId !== 'string' || !ORDER_ID.test(order.orderId)) {
      throw new SchemaError(PROVIDER, '5Post returned an invalid order');
    }
    if (sameNumber(order.clientOrderId, number)) ids.add(order.orderId.toLowerCase());
  }
  if (!ids.size) throw new IndeterminateError(PROVIDER, '5Post answered for another shipment');
  if (ids.size > 1) throw new IndeterminateError(PROVIDER, '5Post holds several orders under this number');
  return [...ids][0]!;
}

/**
 * The status history of `GET /v3/mobile/orders/{orderId}/status-history`,
 * oldest first. Every row has an instant with its offset. 5Post's own rows
 * (`primaryStatus`) carry the order's id; the customs broker's do not, and can
 * carry the broker's contacts, which are not kept, nor are location ids.
 */
function history(payload: unknown, orderId: string): CarrierEvent[] {
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, '5Post returned an invalid status history');
  const seen = new Set<string>();
  const rows: { event: CarrierEvent; at: number; index: number }[] = [];
  payload.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, '5Post returned an invalid status');
    // 5Post's own rows carry the order's id; the customs broker's rows come without one.
    if (row.id === undefined && row.primaryStatus === true) throw new SchemaError(PROVIDER, '5Post returned a status without its order');
    if (row.id !== undefined && (typeof row.id !== 'string' || row.id.toLowerCase() !== orderId)) {
      throw new IndeterminateError(PROVIDER, '5Post answered for another shipment');
    }
    const code = text(row, 'status', 80);
    const at = explicitOffsetTime(row.changeDate);
    if (!CODE.test(code) || !at) throw new SchemaError(PROVIDER, '5Post returned a status without a code or clock');
    const description = text(row, 'statusLocalized') || fivePostWording(code) || code;
    const location = WAREHOUSE_CODES.has(code) ? WAREHOUSE.exec(description)?.[1]?.trim() : undefined;
    const staged = fivePostStage(code, description);
    const event: CarrierEvent = {
      time: at.iso,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      provider_code: code,
    };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ event, at: at.timestamp, index });
  });
  // Newest first; of two rows at one instant, the later in the reply is newer.
  return rows.sort((left, right) => right.at - left.at || right.index - left.index).map((row) => row.event);
}

/**
 * The point the parcel waits at, or was collected from: its name and address
 * from the order's details. Only a pickup point or locker is named, never a
 * door the parcel goes to.
 */
function pickupPoint(details: Record<string, unknown>): string {
  const info = isRecord(details.locationInfo) ? details.locationInfo : null;
  const receiver = info && isRecord(info.receiver) ? info.receiver : null;
  if (!receiver || receiver.type !== 'PICKUP_POINT') return '';
  return [text(receiver, 'name', 160), text(receiver, 'address', 300)].filter(Boolean).join('\n');
}

/**
 * One order: its details from `GET /v3/mobile/order-tracking/{number}/orders/{orderId}`
 * and its status history. The details must carry both the number and the
 * order's id. Their `orderStatus` is the status the app heads the order with,
 * and decides the stage; it can be newer than the history's last row.
 */
export function parseFivePost(details: unknown, statuses: unknown, rawOrderId: string, raw: string): CarrierResult {
  const number = normalizeFivePostNumber(raw);
  const orderId = rawOrderId.toLowerCase();
  if (!isRecord(details)) throw new SchemaError(PROVIDER, '5Post returned invalid order details');
  if (typeof details.orderId !== 'string' || details.orderId.toLowerCase() !== orderId || !sameNumber(details.clientOrderId, number)) {
    throw new IndeterminateError(PROVIDER, '5Post answered for another shipment');
  }
  const status = text(details, 'orderStatus', 80);
  if (!CODE.test(status)) throw new SchemaError(PROVIDER, '5Post returned an order without its status');
  const events = history(statuses, orderId);
  const wording = events.find((event) => event.provider_code === status)?.description ?? fivePostWording(status) ?? status;
  const current = fivePostStage(status, wording);
  const stage = current?.stage;

  const assigned = explicitOffsetTime(details.orderStatusAssignmentDate);
  const newest = events[0] ? explicitOffsetTime(events[0].time) : null;
  const updated = assigned && (!newest || assigned.timestamp > newest.timestamp) ? assigned : newest;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const deliveredAt = delivered?.time ?? (stage === 'delivered' ? assigned?.iso : undefined);
  const collected = delivered !== undefined && lastMovement(events.slice(events.indexOf(delivered) + 1)) === 'ready_for_pickup';
  const point = stage === 'ready_for_pickup' || collected ? pickupPoint(details) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: wording,
    ...(events.length ? {} : { provider_code: status, summary_only: true }),
    last_update: updated?.iso ?? null,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
