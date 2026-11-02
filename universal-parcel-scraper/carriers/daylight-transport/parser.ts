import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { daylightStage } from './status.js';

export const PROVIDER = 'Daylight Transport';
// A shipment's details and its history are a few kilobytes each.
export const DAYLIGHT_MAX_BYTES = 256 * 1024;
// Eight digits, the length of every probill seen. Probills carry no check digit.
const NUMBER = /^\d{8}$/;
// A clock as the replies write it: a wall time to the second, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// The date the replies give a clock they do not have.
const UNSET = '0001-01-01';
// A customer's place as a history row gives it: its ZIP code, town and state.
const CUSTOMER_PLACE = /^\d{5}(?:-?\d{4})?\s+([A-Z][A-Z .'-]*?)\s+([A-Z]{2})$/;
// A terminal as a history row gives it: the terminal's code, its carrier's code and its town.
const TERMINAL = /^[A-Z0-9]{2,5}-[A-Z0-9]{2,5}-([A-Z][A-Z .'-]*)$/;
// The shipment statuses of the details seen in replies, with the page's name for each.
const STATUSES: Readonly<Record<string, { text: string; stage: Stage }>> = {
  Requested: { text: 'Requested', stage: 'registered' },
  InTransit: { text: 'In Transit', stage: 'in_transit' },
  Delivered: { text: 'Delivered', stage: 'delivered' },
};
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Daylight probill, as typed; anything else is not one its tracker looks up. */
export function normalizeDaylightNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Daylight probills are eight digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`Daylight returned an invalid ${key}`);
  return value;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Daylight returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A clock's wall time, or null when the reply gives none. No clock names its zone. */
function clockOf(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value || value.startsWith(UNSET)) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid(`Daylight returned an invalid ${key}`);
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid(`Daylight returned an invalid ${key}`);
  return `${day}T${hour}:${minute}:${second}`;
}

/** A row's place: a customer's town and state without the ZIP code, or a terminal's town. */
function placeOf(raw: string): string {
  const value = raw.toUpperCase();
  const customer = CUSTOMER_PLACE.exec(value);
  if (customer) return `${customer[1]}, ${customer[2]}`;
  const terminal = TERMINAL.exec(value);
  if (terminal) return terminal[1]!.trim();
  // A part holding a digit could be a street or a postcode, so it is left out.
  return value.split(' ').filter((part) => part && !/\d/.test(part)).join(' ');
}

/** The wording as the page prints it: each word capitalized. */
function titleCase(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/(^|[\s/-])(\p{L})/gu, (_match, before: string, letter: string) => before + letter.toUpperCase());
}

/** The rows of the history reply, `{"success":true,"item":[…]}`. */
function historyRows(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.item)) invalid('Daylight returned an invalid history');
  const rows: unknown[] = payload.item;
  if (rows.length > MAX_ROWS) invalid('Daylight returned an oversized history');
  return rows.map((row) => (isRecord(row) ? row : invalid('Daylight returned an invalid history row')));
}

/**
 * One history row: its `discreteStatus`, `updateDate` and `location`. Its
 * `shipmentStatus` is the shipment's class, which rows give out of step with
 * the scans, and the terminal it heads for with its ETA there are not read.
 */
function projectRow(row: Record<string, unknown>): CarrierEvent {
  const wording = text(row, 'discreteStatus', 160);
  if (!wording) invalid('Daylight returned a history row without its status');
  const clock = clockOf(row, 'updateDate');
  if (!clock) invalid('Daylight returned a history row without its time');
  const location = placeOf(text(row, 'location', 120));
  const description = titleCase(wording);
  const staged = daylightStage(description);
  return {
    local_time: clock,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The details' answer for a probill the tracker does not know: an empty search inside a failed envelope. */
export function isDaylightUnknown(payload: unknown): boolean {
  if (!isRecord(payload) || payload.Success !== false || !isRecord(payload.Item)) return false;
  const items = payload.Item.Items;
  return Array.isArray(items) && items.length === 0;
}

/** The shipment the details reply holds, when it is the probill asked. */
function shipmentOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.item)) invalid('Daylight returned an invalid shipment envelope');
  const shipment = payload.item;
  if (text(shipment, 'probill', 40) !== number) throw new IndeterminateError(PROVIDER, 'Daylight answered for another shipment');
  return shipment;
}

/** The day of a window's start, the day the page shows for it. */
function windowDay(window: Record<string, unknown>): string | null {
  return clockOf(window, 'startDate')?.slice(0, 10) ?? null;
}

/** The delivery's clock, when its window is one instant, else its day. */
function deliveryClock(window: Record<string, unknown>): string | null {
  const start = clockOf(window, 'startDate');
  return start && start === clockOf(window, 'endDate') ? start : start?.slice(0, 10) ?? null;
}

/**
 * The replies of the two lookups the shipment page at
 * `mydaylight.dylt.com/external/shipment?probill={number}` makes:
 * `api/v1/shipments/public` gives the shipment's details and
 * `api/v1/shipments/history/public` its history, newest first. A probill the
 * tracker does not know is an HTTP 404 with an empty search in the details and
 * an empty history. The details must name the probill asked. They also hold
 * the shipper, the consignee and the forwarder with their addresses, contacts,
 * phones and e-mails, the customer's references, the items and their weights,
 * the billing party and the delivery notification's e-mails; none of them is
 * read.
 */
export function parseDaylight(details: { status: number; body: unknown }, history: unknown, raw: string): CarrierResult {
  const number = normalizeDaylightNumber(raw);
  const rows = historyRows(history);
  if (details.status === 404) {
    if (!isDaylightUnknown(details.body)) invalid('Daylight returned an invalid answer for a missing shipment');
    // The page reports the probill as not to be shown; a history under it would contradict that.
    if (rows.length) throw new IndeterminateError(PROVIDER, 'Daylight\'s lookups disagree about the probill');
    throw new NotFoundError(PROVIDER);
  }
  const shipment = shipmentOf(details.body, number);
  const status = text(shipment, 'status', 40);
  const known = Object.hasOwn(STATUSES, status) ? STATUSES[status] : undefined;

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const event of rows.map(projectRow)) {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // The details' delivery time dates a delivery the history does not record.
  let delivery = events.find((event) => event.stage === 'delivered');
  const delivered = status === 'Delivered';
  if (delivered && !delivery) {
    const clock = deliveryClock(record(shipment, 'delivery'));
    if (clock) {
      delivery = { local_time: clock, description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' };
      events.unshift(delivery);
    }
  }
  if (!events.length && !status) throw new NoHistoryError(PROVIDER);

  // A status the map does not know goes to the shared wording rules.
  const worded = status && !known ? classifyWording(status, 'in_transit') : null;
  const fromWording = worded && worded.source !== 'none' ? worded : null;
  // A delivery ends the shipment. The details' status settles a delivery the history does not
  // record, and a cancellation or a return; otherwise the newest staged row is the current
  // state, then the details' status.
  const settling: ClassifiedWording | null = delivery ? null
    : delivered ? { stage: 'delivered', source: 'carrier_map' }
      : fromWording && ['exception', 'returned'].includes(fromWording.stage) ? fromWording : null;
  const staged = delivery ?? events.find((event) => event.stage);
  const decided: ClassifiedWording | null = settling
    ?? (staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null)
    ?? (known ? { stage: known.stage, source: 'carrier_map' } : fromWording);
  const stage = decided?.stage;
  // A status that settles the shipment ahead of every row is the current state, without a clock.
  const current = settling ? undefined : events[0];
  const settled = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: current?.description ?? (known?.text || status || null),
    last_update: null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    // Until the delivery, the page shows the delivery window as the estimated delivery time.
    expected_delivery: settled ? null : windowDay(record(shipment, 'delivery')),
    ...(rows.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
