import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, usStateTimeZone } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pyleStage, pyleWordingStage } from './status.js';

export const PROVIDER = 'A. Duie Pyle';
// A shipment's reply is a few kilobytes.
export const PYLE_MAX_BYTES = 256 * 1024;
// The service's own rule: "Pro numbers must be 8 or 9 numbers".
const NUMBER = /^\d{8,9}$/;
// A clock as the reply writes it, a wall time to the second, with its offset in a field of its own.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
// The pickup, appointment and arrival windows the history lists among its rows; none is a movement.
const WINDOW = /\bWINDOW$/i;
// The windows that time the delivery, in the order they are read: the page shows the ETA window.
const DELIVERY_WINDOWS = ['ETA WINDOW', 'DELIVERY APPOINTMENT WINDOW'];
// The answer for a PRO the tracker does not know, which echoes the number asked.
const NOT_FOUND = 'We are unable to find this shipment.';
// States whose places keep different clocks, so a state does not settle a clock's zone.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
// The partners the page links a hand-off to, by their SCAC.
const PARTNERS: Readonly<Record<string, string>> = { DAFG: 'dayton-freight', SEFL: 'southeastern-freight-lines', OAKH: 'oak-harbor' };
const PARTNER_PRO = /^[A-Z0-9]{4,30}$/;
const WEIGHT = /^\d+(?:\.\d+)?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_RESULTS = 25;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An A. Duie Pyle PRO number; anything else is not one its tracker looks up. */
export function normalizePyleNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'A. Duie Pyle PRO numbers are eight or nine digits');
  return number;
}

function invalid(message = 'A. Duie Pyle returned an unexpected reply'): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`A. Duie Pyle returned an invalid ${key}`);
  return value;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`A. Duie Pyle returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Clock {
  /** The wall clock, or its day when the reply gives midnight, which marks a clock without a time. */
  readonly wall: string;
  readonly day: string;
  /** The instant, when the clock's offset is the one its place keeps then. */
  readonly time: string | null;
}

/**
 * The zone of a place in a US state that keeps one clock throughout. A
 * Canadian place, or one in a state split between zones, has none.
 */
function zoneOf(state: string): string | null {
  return SPLIT_STATES.has(state) ? null : usStateTimeZone(state);
}

/**
 * A clock of the reply: `key` holds the wall time and `{key}UTC` its offset.
 * The offset is trusted only where it is the one the place's zone keeps at
 * that instant, so a clock labelled with another zone's offset, or one
 * without a place, stays a wall clock.
 */
function clockOf(row: Record<string, unknown>, key: string, state: string): Clock | null {
  const value = text(row, key, 32);
  if (!value) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid('A. Duie Pyle returned an invalid clock');
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // Luxon accepts hour 24, so the clock's fields are checked here.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid('A. Duie Pyle returned an invalid clock');
  const offset = text(row, `${key}UTC`, 8);
  if (offset && !OFFSET.test(offset)) invalid('A. Duie Pyle returned an invalid clock offset');
  if (`${hour}${minute}${second}` === '000000') return { wall: day, day, time: null };
  const zone = zoneOf(state);
  const read = offset && zone ? DateTime.fromISO(`${value}${offset}`, { setZone: true }) : null;
  const kept = read?.isValid && read.offset === read.setZone(zone!).offset;
  return { wall: value, day, time: kept ? read.toISO({ suppressMilliseconds: true }) : null };
}

interface Row {
  readonly index: number;
  readonly description: string;
  readonly start: Clock;
  readonly end: Clock | null;
  readonly event: CarrierEvent;
}

/** One row of `statusHistory`: its wording, place and clocks. */
function readRow(row: unknown, index: number): Row {
  if (!isRecord(row)) invalid('A. Duie Pyle returned an invalid history row');
  const description = text(row, 'description', 120);
  if (!description) invalid('A. Duie Pyle returned a history row without wording');
  const state = text(row, 'state', 4).toUpperCase();
  const location = text(row, 'location', 120) || [text(row, 'city', 80), state].filter(Boolean).join(', ');
  const start = clockOf(row, 'start', state);
  if (!start) invalid('A. Duie Pyle returned a history row without its clock');
  const staged = pyleStage(description);
  const event: CarrierEvent = {
    ...(start.time ? { time: start.time } : { local_time: start.wall }),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { index, description, start, end: clockOf(row, 'end', state), event };
}

/** The estimate the page shows until the delivery: the latest ETA window, else the delivery appointment, else the day due. */
function estimate(windows: readonly Row[], shipment: Record<string, unknown>): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const latest = [...windows].reverse();
  const window = DELIVERY_WINDOWS.map((wording) => latest.find((row) => row.description.toUpperCase() === wording))
    .find((row) => row !== undefined);
  if (window) {
    const { start, end } = window;
    if (start.time && end?.time && Date.parse(start.time) < Date.parse(end.time)) {
      return { expected_delivery: end.time, expected_delivery_from: start.time };
    }
    const last = end && end.day > start.day ? end.day : start.day;
    return { expected_delivery: last, ...(last > start.day ? { expected_delivery_from: start.day } : {}) };
  }
  return { expected_delivery: clockOf(shipment, 'estimatedDeliveryTime', '')?.day ?? null };
}

/** The shipment's weight, which the page shows in pounds without a unit, in kilograms. */
function weightOf(shipment: Record<string, unknown>): number | null {
  const value = cleanScalar(record(shipment, 'shipmentDetails').weight, 16);
  const pounds = WEIGHT.test(value) ? Number(value) : 0;
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/** The partner a shipment is handed to for delivery, with its own PRO, when the page links one. */
function handoff(shipment: Record<string, unknown>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const scac = text(shipment, 'interlineTo', 8).toUpperCase();
  const pro = text(shipment, 'interlineToPro', 40).toUpperCase().replace(/[\s-]/g, '');
  return Object.hasOwn(PARTNERS, scac) && PARTNER_PRO.test(pro) ? { delivery_carrier: PARTNERS[scac]!, delivery_tracking_number: pro } : {};
}

/**
 * The reply of `wp-json/adp/2/shipment/status?type=0&value={PRO}`, the lookup
 * A. Duie Pyle's shipment status page makes:
 * `{"response":{"shipmentStatus":{"result":[…]}}}`, whose first result the
 * page shows. A PRO it does not know comes back as a result holding the
 * number and `We are unable to find this shipment.`. The result also names
 * the shipper, the consignee and the paying customer with their addresses,
 * and holds the bill of lading, the purchase order and a comment; none of
 * them is read.
 */
export function parsePyle(payload: unknown, raw: string): CarrierResult {
  const number = normalizePyleNumber(raw);
  if (!isRecord(payload)) invalid('A. Duie Pyle returned an invalid envelope');
  const results = record(record(payload, 'response'), 'shipmentStatus').result;
  if (!Array.isArray(results) || results.length > MAX_RESULTS) invalid('A. Duie Pyle returned an invalid envelope');
  const shipment: unknown = results[0];
  if (shipment === undefined) throw new IndeterminateError(PROVIDER, 'A. Duie Pyle did not complete the lookup');
  if (!isRecord(shipment) || typeof shipment.pro !== 'string') invalid('A. Duie Pyle returned a shipment without its PRO');
  if (clean(shipment.pro, 32) !== number) throw new IndeterminateError(PROVIDER, 'A. Duie Pyle answered for another shipment');
  const error = text(shipment, 'errorMessage', 200);
  if (error) {
    if (error === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'A. Duie Pyle did not complete the lookup');
  }

  const rows = shipment.statusHistory ?? [];
  if (!Array.isArray(rows)) invalid('A. Duie Pyle returned an invalid history');
  if (rows.length > MAX_ROWS) invalid('A. Duie Pyle returned an oversized history');
  const read = rows.map(readRow);
  const windows = read.filter((row) => WINDOW.test(row.description));
  const seen = new Set<string>();
  const scans: Row[] = [];
  for (const row of read) {
    if (WINDOW.test(row.description)) continue;
    // A scan the reply lists twice is kept once.
    const key = JSON.stringify([row.start.wall, row.description, row.event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(row);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The reply lists the scans oldest first, with the windows after them; every
  // place on the network keeps Eastern time, so the wall clocks order the scans.
  scans.sort((a, b) => (a.start.wall === b.start.wall ? b.index - a.index : a.start.wall < b.start.wall ? 1 : -1));
  const events = scans.map((row) => row.event);

  const newest = events[0]!;
  // A delivery ends the shipment: a scan recorded after it moves nothing.
  const delivery = scans.find((row) => row.event.stage === 'delivered');
  const staged = delivery?.event ?? events.find((event) => event.stage);
  // The shipment's own status counts when it says the delivery the history has not reached.
  const summary = pyleWordingStage(text(shipment, 'status', 80)) === 'delivered' && !delivery;
  const stage = (summary ? 'delivered' : staged?.stage) as Stage | undefined;
  const source = summary ? 'carrier_map' : staged?.stage_source;
  // The page dates the delivery with the end of its row.
  const deliveredAt = delivery ? delivery.end?.time ?? delivery.start.time : null;
  const settled = stage === 'delivered' || stage === 'returned';
  const weight = weightOf(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(settled ? { expected_delivery: null } : estimate(windows, shipment)),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...handoff(shipment),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
