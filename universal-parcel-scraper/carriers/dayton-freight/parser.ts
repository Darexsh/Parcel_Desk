import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { daytonStage } from './status.js';

export const PROVIDER = 'Dayton Freight';
// A shipment's reply is about a kilobyte.
export const DAYTON_MAX_BYTES = 128 * 1024;
// A PRO is seven to ten digits; its barcode pads it with zeros to eleven.
const NUMBER = /^\d{7,11}$/;
const PRO = /^[1-9]\d{6,9}$/;
// A clock as the reply writes it: a wall time to the second, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// The date the reply gives a clock it does not have.
const UNSET = '0001-01-01';
// The three result lists of the page's PRO search: freight, expedited and truckload.
const LISTS = ['dflResults', 'dfxResults', 'dftResults'] as const;
// The partners the page names by their SCAC when they take the freight on.
const PARTNERS: Readonly<Record<string, string>> = { PYLE: 'a-duie-pyle', SEFL: 'southeastern-freight-lines', OAKH: 'oak-harbor' };
const PARTNER_PRO = /^[A-Z0-9]{4,30}$/;
const MAX_RESULTS = 25;

/** A Dayton Freight PRO number, as typed; anything else is not one its tracker looks up. */
export function normalizeDaytonNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || !PRO.test(number.replace(/^0+/, ''))) {
    throw new InvalidInputError(PROVIDER, 'Dayton Freight PRO numbers are seven to ten digits, padded with zeros to at most eleven');
  }
  return number;
}

/** The PRO as the tracker prints it, without the barcode's zeros. */
export function printedPro(raw: string): string {
  return normalizeDaytonNumber(raw).replace(/^0+/, '');
}

function invalid(message = 'Dayton Freight returned an unexpected reply'): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`Dayton Freight returned an invalid ${key}`);
  return value;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Dayton Freight returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The PRO a result is for, which the reply gives as a number. */
function proOf(row: Record<string, unknown>): string {
  const value = row.pro;
  const pro = typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' && /^\d{1,11}$/.test(value.trim()) ? value.trim().replace(/^0+/, '') : '';
  if (!pro) invalid('Dayton Freight returned a shipment without its PRO');
  return pro;
}

/**
 * A clock's wall time, or its day when the clock is midnight, which the reply
 * gives a date without a time. No clock names its zone.
 */
function clockOf(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value || value.startsWith(UNSET)) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid(`Dayton Freight returned an invalid ${key}`);
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid(`Dayton Freight returned an invalid ${key}`);
  return `${hour}${minute}${second}` === '000000' ? day : `${day}T${hour}:${minute}:${second}`;
}

/** A town and state; a part holding a digit could be a street or a postcode, so it is left out. */
function placeOf(row: Record<string, unknown>): string {
  return [text(row, 'city', 80), text(row, 'state', 4).toUpperCase()].filter((part) => part && !/\d/.test(part)).join(', ');
}

/** The result for the PRO asked, in the page's order of its three lists. */
function shipmentOf(payload: unknown, pro: string): Record<string, unknown> {
  if (!isRecord(payload)) invalid('Dayton Freight returned an invalid envelope');
  const rows: unknown[] = [];
  for (const key of LISTS) {
    const list: unknown = payload[key];
    if (!Array.isArray(list) || list.length > MAX_RESULTS) invalid('Dayton Freight returned an invalid envelope');
    rows.push(...(list as unknown[]));
  }
  // The page answers "No results" when none of the lists has one.
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const own = rows.find((row) => {
    if (!isRecord(row)) invalid('Dayton Freight returned an invalid shipment');
    return proOf(row) === pro;
  }) as Record<string, unknown> | undefined;
  if (!own) throw new IndeterminateError(PROVIDER, 'Dayton Freight answered for another shipment');
  return own;
}

/** The partner taking the freight on for delivery, with its own PRO, when it is a carrier the library knows. */
function handoff(shipment: Record<string, unknown>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const partner = record(shipment, 'destinationPartner');
  const code = text(partner, 'code', 8).toUpperCase();
  const value = partner.pro;
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') {
    invalid('Dayton Freight returned an invalid partner PRO');
  }
  const pro = clean(String(value ?? ''), 40).toUpperCase().replace(/[\s-]/g, '');
  return Object.hasOwn(PARTNERS, code) && PARTNER_PRO.test(pro) ? { delivery_carrier: PARTNERS[code]!, delivery_tracking_number: pro } : {};
}

/** The day the page gives for the delivery: the appointment's, else the estimate. */
function estimateOf(shipment: Record<string, unknown>): string | null {
  const appointment = clockOf(shipment, 'appointmentTo') ?? clockOf(shipment, 'appointmentFrom');
  return (appointment ?? clockOf(shipment, 'estimatedDeliveryDate'))?.slice(0, 10) ?? null;
}

function milestone(clock: string, description: string, stage: 'accepted' | 'customs' | 'in_transit'): CarrierEvent {
  return { local_time: clock, description, stage, stage_source: 'carrier_map' };
}

/**
 * The reply of `api/t/byNumber?numbers={PRO}&type=Pro`, the lookup Dayton
 * Freight's tracking search makes: `{"dflResults":[…],"dfxResults":[…],
 * "dftResults":[…]}`, each result a shipment's current status, pickup, delivery,
 * estimate and partners. It has no history. Every list empty is the page's "No
 * results". The status names who signed for a delivery and the trailer, and its
 * service center comes with its address, phone and position; none of them is
 * read.
 */
export function parseDayton(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDaytonNumber(raw);
  const pro = printedPro(number);
  const shipment = shipmentOf(payload, pro);
  const status = record(shipment, 'status');
  const code = text(status, 'activityCode', 8).toUpperCase();
  const activity = text(status, 'activity', 160);
  const clock = clockOf(status, 'time');
  const place = placeOf(status) || (text(record(status, 'serviceCenter'), 'id', 8) ? placeOf(record(status, 'serviceCenter')) : '');
  const staged = code || activity ? daytonStage(code, activity) : null;

  const events: CarrierEvent[] = [];
  if (clock && (code || activity)) {
    events.push({
      local_time: clock,
      ...(place ? { location: place } : {}),
      ...(activity ? { description: activity } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  const cleared = clockOf(status, 'clearedCustoms');
  if (cleared) events.push(milestone(cleared, 'Cleared Customs', 'in_transit'));
  const border = clockOf(status, 'arrivedAtBorder');
  if (border) events.push(milestone(border, 'Arrived at Border', 'customs'));
  // The page shows the partner's pickup day for freight a partner collected, else the pickup.
  const pickup = clockOf(record(shipment, 'originPartner'), 'pickupDate') ?? clockOf(shipment, 'pickupDate');
  // A pickup still to come, or the status that is the pickup, adds none.
  if (pickup && staged?.stage !== 'registered' && code !== 'PUP' && (!clock || pickup <= clock)) {
    events.push(milestone(pickup, 'Picked Up', 'accepted'));
  }
  // Newest first; a status keeps its place on a tie.
  events.sort((a, b) => (a.local_time === b.local_time ? 0 : String(a.local_time) < String(b.local_time) ? 1 : -1));
  if (!code && !activity && !events.length) throw new NoHistoryError(PROVIDER);

  // The status is the current state, dated by its own clock; without a status, the newest milestone is.
  const current = code || activity ? { description: activity, local_time: clock } : events[0]!;
  // The page's rail counts a status whose code it does not name as in transit.
  const decided: ClassifiedWording = staged
    ?? (code || activity ? { stage: 'in_transit', source: 'carrier_map' } : { stage: events[0]!.stage as Stage, source: 'carrier_map' });
  const stage = decided.stage;
  const settled = stage === 'delivered' || stage === 'returned';
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: decided.source,
    last_status_text: current.description || null,
    last_update: null,
    ...(current.local_time ? { last_update_local: current.local_time } : {}),
    expected_delivery: settled ? null : estimateOf(shipment),
    ...handoff(shipment),
    ...(pro !== number ? { canonical_tracking_number: pro } : {}),
    summary_only: true,
    events,
  };
}
