import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cseNotice, cseStage } from './status.js';

export const PROVIDER = 'CSE';
// A waybill with its order, a pickup point and a return waybill is under twenty kilobytes.
export const CSE_MAX_BYTES = 512 * 1024;
// Letters and digits, eight or more with a digit: CSE's own numbers and the
// references its tracker also takes. A shorter one can be any client's.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// The order a waybill was issued for, as its creation event names it:
// "По документу: Заказ 000-000000000 от …, зарегистрирована накладная: …".
const ORDER = /(?:^|\s)Заказ\s+([\p{L}\d-]+)\s+от\s/u;
const MAX_ITEMS = 20;
const MAX_ROWS = 200;
// Events that name only their kind. The reason they carry is their info up to
// the colon; what follows can be an operator's own words.
const REASONED = new Set(['информация по отправлению', 'оформлена добавочная накладная']);
// Events whose place is the office that recorded them, not where the parcel was:
// the waybill's registration, and the warehouse and transit in China.
const PLACELESS = new Set(['отправление создано', 'отправление поступило на склад (китай)', 'груз в транзите китай-россия']);

/** A number for CSE's tracker, normalized; anything else is not one it takes. */
export function normalizeCseNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CSE numbers are eight or more letters and digits');
  return number;
}

/**
 * What the tracker is asked for a normalized number: CSE's own layout first,
 * which it finds only with its hyphens, then the number as it is, as it takes
 * references. Orders and waybills are three digits, a hyphen and nine or ten
 * digits, three digits and two groups of seven and five or six, or three
 * digits and two letters before the rest.
 */
export function cseQueries(number: string): string[] {
  const layout = /^(\d{3})(\d{9,10})$/.exec(number) ?? /^(\d{3})(\d{7})(\d{5,6})$/.exec(number)
    ?? /^(\d{3})([A-Z]{2})([A-Z\d]\d{7,9})$/.exec(number);
  return layout ? [layout.slice(1).join('-'), number] : [number];
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `CSE returned an invalid ${key}`);
  return clean(value, maxLength);
}

function list(value: unknown, what: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new SchemaError(PROVIDER, `CSE returned invalid ${what}`);
  return value;
}

/**
 * An event's wording. Its name, and for a note on the shipment or a
 * supplementary waybill the reason its info gives before the colon:
 * "Информация по отправлению. Получатель/ компания на адресе не найдены".
 * Info without such a reason is dropped, as is every other event's: it names
 * couriers, documents and addresses.
 */
export function cseWording(name: string, info = ''): string {
  if (!REASONED.has(normalizeStatusWording(name))) return name;
  const colon = info.indexOf(':');
  const reason = colon > 0 ? clean(info.slice(0, colon)) : '';
  return reason && !/\d/.test(reason) ? `${name}. ${reason}` : name;
}

/** A scan's wall clock to the minute. The reply names no zone, so it stays local. */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'EventDate', 32));
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'CSE returned an invalid event time');
  }
  return local;
}

/** A calendar day, or null for a missing or unusable one. */
function day(row: Record<string, unknown>, key: string): string | null {
  const match = DAY.exec(text(row, key, 16));
  const value = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
  return value >= '2000-01-01' && DateTime.fromISO(value, { zone: 'UTC' }).toISODate() === value ? value : null;
}

/** The town of a pickup point's address, as CSE names towns: "Пример г". */
function pickupTown(address: string): string {
  const town = address.split(',').map((part) => part.trim()).find((part) => /^г\.?\s+\S/u.test(part));
  return town ? `${town.replace(/^г\.?\s+/u, '')} г` : '';
}

interface Row {
  event: CarrierEvent;
  index: number;
  /** The address of the pickup point the event happened at. */
  pickup: string;
}

function projectRow(row: unknown, index: number, waybill: boolean): Row {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CSE returned an invalid event');
  const name = text(row, 'EventName', 160);
  if (!name) throw new SchemaError(PROVIDER, 'CSE returned an event without wording');
  const description = cseWording(name, text(row, 'EventInfo', 500));
  const local = scanClock(row);
  const point = isRecord(row.EventPvzInfo) ? row.EventPvzInfo : null;
  const pickup = point ? text(point, 'Address', 200) : '';
  // The place is the CSE office that recorded the event. A pickup point's
  // events take the point's own town: the office can be in another region.
  const location = !waybill || PLACELESS.has(normalizeStatusWording(name)) ? ''
    : point ? pickupTown(pickup) : text(row, 'EventGeography', 120);
  const staged = cseStage(description, text(row, 'EventNameEn', 160));
  return { index, pickup, event: {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The orders a shipment's waybill events say it was issued for. */
function orders(item: Record<string, unknown>): string[] {
  const rows = isRecord(item.History) && Array.isArray(item.History.waybill_info) ? item.History.waybill_info : [];
  return rows.flatMap((row) => {
    const info = isRecord(row) && typeof row.EventInfo === 'string' ? ORDER.exec(row.EventInfo) : null;
    return info ? [info[1]!.toUpperCase()] : [];
  });
}

/** Whether a shipment answers a query: its number echoes it, or its waybill names it as its order. */
function answers(item: Record<string, unknown>, query: string): boolean {
  if (typeof item.Number !== 'string') throw new SchemaError(PROVIDER, 'CSE returned a shipment without its number');
  return clean(item.Number, 64).toUpperCase() === query || orders(item).includes(query);
}

/**
 * The reply of `/api/new-track/{numbers}`, the lookup CSE's tracking page
 * makes, for the queries `cseQueries` gives a number. A shipment found for a
 * waybill or a reference echoes the query as its number; one found for its
 * order carries its waybill's number, and its creation event names the order.
 * A number the tracker does not know comes back in `notfound`. The waybill's
 * and the order's events are the history; couriers, documents and the pickup
 * point's contacts in their info are never kept.
 */
export function parseCse(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCseNumber(raw);
  const queries = cseQueries(number);
  if (!isRecord(payload) || !Array.isArray(payload.found) || !Array.isArray(payload.notfound) || payload.found.length > MAX_ITEMS) {
    throw new SchemaError(PROVIDER, 'CSE returned an invalid envelope');
  }
  const items = payload.found.map((item) => {
    if (!isRecord(item)) throw new SchemaError(PROVIDER, 'CSE returned an invalid shipment');
    return item;
  });
  const item = queries.map((query) => items.find((candidate) => answers(candidate, query))).find((found) => found !== undefined);
  if (!item) {
    if (items.length) throw new IndeterminateError(PROVIDER, 'CSE answered for another shipment');
    const missing = new Set(payload.notfound.map((value) => (typeof value === 'string' ? clean(value, 64).toUpperCase() : '')));
    if (queries.every((query) => missing.has(query))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'CSE returned a reply without the number asked');
  }
  if (item.Error === true) throw new IndeterminateError(PROVIDER, 'CSE could not read the shipment');

  const history = item.History ?? {};
  if (!isRecord(history)) throw new SchemaError(PROVIDER, 'CSE returned an invalid history');
  const waybill = list(history.waybill_info, 'waybill events');
  const rows = [...waybill.map((row, index) => projectRow(row, index, true)),
    ...list(history.order_info, 'order events').map((row, index) => projectRow(row, waybill.length + index, false))];
  // Newest first; of two events at one clock, the earlier in the reply is newer.
  const seen = new Set<string>();
  const sorted = rows
    .sort((left, right) => (right.event.local_time as string).localeCompare(left.event.local_time as string) || left.index - right.index)
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const events = sorted.map(({ event }) => event);

  // The status the page shows over the history, worded like an event.
  const state = text(item, 'State', 160);
  const summary = state ? cseWording(state, text(item, 'Info', 500)) : '';
  if (!summary && !events.length) throw new NoHistoryError(PROVIDER);
  const summarized = summary ? cseStage(summary, text(item, 'StateEn', 160)) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (summarized?.stage ?? scanned?.stage) as Stage | undefined;
  const stageSource = summarized ? summarized.source : scanned?.stage_source;

  // A parcel waiting at a pickup point, or collected from one, names its
  // address. Notices between its arrival there and its delivery moved nothing.
  const delivery = stage === 'delivered' ? events.findIndex((event) => event.stage === 'delivered') : -1;
  const collected = delivery >= 0
    && lastMovement(events.slice(delivery + 1).filter((event) => event.stage || !cseNotice(event.description ?? ''))) === 'ready_for_pickup';
  const pickup = stage === 'ready_for_pickup' || collected
    ? sorted.slice(delivery + 1).find((row) => row.event.stage === 'ready_for_pickup' && row.pickup)?.pickup ?? '' : '';
  const expected = stage === 'delivered' || stage === 'returned' ? null : day(item, 'PlannedDeliveryDate');
  const weight = typeof item.Weight === 'number' && Number.isFinite(item.Weight) && item.Weight > 0 ? item.Weight : null;
  // Found by its order, the shipment carries its waybill's number, kept when it reads back in CSE's layout.
  const own = clean(item.Number, 64).toUpperCase();
  const waybillNumber = normalizeTrackingNumber(own);
  const canonical = waybillNumber !== number && cseQueries(waybillNumber).includes(own) ? waybillNumber : '';
  const newest = events[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: stageSource ?? 'carrier_map' } : {}),
    last_status_text: summary || newest!.description!,
    ...(events.length ? {} : { summary_only: true }),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    events,
  };
}
