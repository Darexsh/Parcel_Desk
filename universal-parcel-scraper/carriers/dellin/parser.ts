import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dellinState, dellinStage } from './status.js';

export const PROVIDER = 'Delovye Linii';
// An order with a dozen documents is under twenty kilobytes.
export const DELLIN_MAX_BYTES = 512 * 1024;
// Dellin's answer to a number it has no order for.
const NOT_FOUND = 717001;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The town a milestone names: "прибыл на терминал г. Казань".
const TOWN = /\sг\.\s+(\S.*)$/u;
const MAX_DOCUMENTS = 200;
const MAX_ROWS = 100;

/**
 * A waybill, printed as a two-digit year, a hyphen and eleven digits and taken
 * with or without the hyphen, or the seven- or eight-digit number of a pickup
 * request. Waybills are sent as printed; anything else is not a number Dellin issues.
 */
export function normalizeDellinNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^\d{13}$/.test(number)) return `${number.slice(0, 2)}-${number.slice(2)}`;
  if (/^\d{7,8}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Delovye Linii numbers are a waybill of thirteen digits or a request of seven or eight');
}

const digits = (value: unknown) => cleanScalar(value, 40).replace(/-/g, '');

/** Whether an order is the one asked for: one of its documents, or the order itself, carries the whole number. */
function names(order: Record<string, unknown>, wanted: string): boolean {
  const documents = order.documents;
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) throw new SchemaError(PROVIDER, 'Delovye Linii returned an order with invalid documents');
  return digits(order.orderId) === wanted || documents.some((document) => isRecord(document) && digits(document.id) === wanted);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Delovye Linii returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The order's dated milestones, oldest first in the reply. A row the order
 * has not reached yet has no `date_full` and a placeholder `date`; a
 * calculated row is a forecast. Neither is a scan.
 */
function milestones(order: Record<string, unknown>): CarrierEvent[] {
  const rows = order.orderDatesExtended ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Delovye Linii returned invalid milestones');
  const seen = new Set<string>();
  const dated: { event: CarrierEvent; index: number }[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Delovye Linii returned an invalid milestone');
    const day = text(row, 'date_full', 16);
    if (!day || row.is_calculated === true) return;
    if (!DATE.test(day) || !DateTime.fromISO(day, { zone: 'UTC' }).isValid) throw new SchemaError(PROVIDER, 'Delovye Linii returned an invalid milestone date');
    const description = text(row, 'description');
    if (!description) throw new SchemaError(PROVIDER, 'Delovye Linii returned a milestone without wording');
    const key = `${day}|${description}`;
    if (seen.has(key)) return;
    seen.add(key);
    const location = TOWN.exec(description)?.[1]?.trim();
    const staged = dellinStage(description);
    dated.push({ index, event: {
      local_time: day,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // Newest first; of two rows on one day, the later in the reply is newer.
  return dated.sort((left, right) => (right.event.local_time as string).localeCompare(left.event.local_time as string) || right.index - left.index)
    .map((row) => row.event);
}

/**
 * The reply of `POST https://api.dellin.ru/v3/orders.json` for one number. An
 * unknown number is HTTP 400 with error 717001, "Заказ не найден". The order
 * must carry the whole number asked as one of its documents or as itself.
 * The order's `state` decides the stage; its dated milestones are the history.
 */
export function parseDellin(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDellinNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Delovye Linii returned an invalid envelope');
  if (payload.errors !== undefined && payload.errors !== null) {
    const errors = Array.isArray(payload.errors) ? payload.errors : [payload.errors];
    if (errors.some((error) => isRecord(error) && error.code === NOT_FOUND)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Delovye Linii refused the lookup');
  }
  const orders = payload.orders;
  if (!Array.isArray(orders)) throw new SchemaError(PROVIDER, 'Delovye Linii returned a reply without orders');
  if (!orders.length) throw new IndeterminateError(PROVIDER, 'Delovye Linii answered without the order');
  const wanted = number.replace(/-/g, '');
  const order = orders.find((candidate) => {
    if (!isRecord(candidate)) throw new SchemaError(PROVIDER, 'Delovye Linii returned an invalid order');
    return names(candidate, wanted);
  }) as Record<string, unknown> | undefined;
  if (!order) throw new IndeterminateError(PROVIDER, 'Delovye Linii answered for another shipment');

  const state = text(order, 'state', 60);
  if (!state) throw new SchemaError(PROVIDER, 'Delovye Linii returned an order without its state');
  const events = milestones(order);
  const stage = dellinState(state);
  const newest = events[0];
  const day = text(order, 'stateDate', 16);
  const updated = newest?.local_time ?? (DATE.test(day) ? day : undefined);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: text(order, 'stateName', 120) || newest?.description || state,
    ...(events.length ? {} : { provider_code: state, summary_only: true }),
    last_update: null,
    ...(updated ? { last_update_local: updated } : {}),
    expected_delivery: null,
    events,
  };
}
