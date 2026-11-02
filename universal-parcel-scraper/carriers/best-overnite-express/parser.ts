import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { boeStage } from './status.js';

export const PROVIDER = 'Best Overnite Express';
// A shipment with its parties and a dozen scans is under two kilobytes.
export const BOE_MAX_BYTES = 256 * 1024;
// A PRO number: eight digits as the classic trace printed it, or nine with the leading zero the service gives it.
const NUMBER = /^\d{8,9}$/;
const PRO_LENGTH = 9;
// The service's answer for a number without a shipment. It echoes a number of PRO form, and none for another form.
const NO_SHIPMENT = 'BADPRONBR';
// A scan's day and clock as the reply writes them: `Apr 06 2026` and `16:00`.
const DAY = /^([A-Z][a-z]{2}) (\d{2}) (\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A day as the reply's other dates write it: `04/11/2026`.
const SLASHED_DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// A delivery receipt's row, whose place is who signed for the freight.
const DELIVERY_ROW = /^DELIVERED\b/i;
// A terminal's town, in letters and spaces; any other place text is not kept.
const TOWN = /^[A-Z]+(?: [A-Z]+)*$/i;
// The status line the page shows for a shipment without scans, when it was delivered.
const DELIVERED_STATUS = /^Delivered on (\d{1,2})\/(\d{1,2})\/(\d{4}) at (\d{2}:\d{2})\b/i;
// States on Pacific time throughout. Oregon and Nevada each keep a corner on Mountain time.
const PACIFIC_STATES = new Set(['CA', 'WA']);
const PACIFIC = 'America/Los_Angeles';
const MAX_ROWS = 500;

/**
 * A Best Overnite PRO number in the nine digits the service gives it; anything
 * else is not one it issues. The service pads a shorter number with zeros and
 * answers for whichever PRO that makes, so only whole PRO numbers are sent.
 */
export function normalizeBoeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Best Overnite PRO numbers are eight or nine digits');
  return number.padStart(PRO_LENGTH, '0');
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`Best Overnite returned an invalid ${key}`);
  return value;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Best Overnite returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Names compared without case, spaces or punctuation: `B. Sample` is `B.SAMPLE`. */
function nameKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The zone the scans' clocks are read in. The reply gives clocks without a
 * zone and places without a state, so the clocks are read in Pacific time only
 * when the shipper and the consignee are both in a state that keeps it
 * throughout, where the carrier's own zone and every place's agree. Elsewhere,
 * such as Arizona or Nevada, they stay wall clocks.
 */
function zoneOf(payload: Record<string, unknown>): string | null {
  const shipper = text(record(payload, 'objShipper'), 'state', 8).toUpperCase();
  const consignee = text(record(payload, 'objConsignee'), 'state', 8).toUpperCase();
  return PACIFIC_STATES.has(shipper) && PACIFIC_STATES.has(consignee) ? PACIFIC : null;
}

interface Clock {
  time?: string;
  local_time?: string;
}

/**
 * A clock on `day`: an instant in the zone when there is one, else a wall
 * clock. Midnight, as on pickups, is a day without a time.
 */
function clockOn(day: string, value: string, zone: string | null): Clock {
  if (!value || value === '00:00') return { local_time: day };
  const clock = CLOCK.exec(value);
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) invalid('Best Overnite returned an invalid time');
  const wall = `${day}T${clock[1]}:${clock[2]}:00`;
  if (!zone) return { local_time: wall };
  return { time: firstOccurrence(DateTime.fromISO(wall, { zone })).toISO({ suppressMilliseconds: true })! };
}

/** A day as the scans write it, `Apr 06 2026`, or null. */
function spelledDay(value: string): string | null {
  const day = DAY.exec(value);
  const month = day ? MONTHS.indexOf(day[1]!) + 1 : 0;
  return day && month ? calendarDay(Number(day[3]), month, Number(day[2])) : null;
}

/**
 * One row of `collHistories`: its `date`, `time`, `description` and
 * `location`. The location is the terminal's town on most rows and who signed
 * on a delivery's, so it is kept only as a town that names nobody the reply
 * names.
 */
function projectRow(row: unknown, zone: string | null, names: ReadonlySet<string>): CarrierEvent {
  if (!isRecord(row)) invalid('Best Overnite returned an invalid scan');
  const description = text(row, 'description', 160);
  if (!description) invalid('Best Overnite returned a scan without its status');
  const day = spelledDay(text(row, 'date', 20));
  if (!day) invalid('Best Overnite returned a scan without a valid day');
  const clock = clockOn(day, text(row, 'time', 10), zone);
  const place = text(row, 'location', 80);
  const kept = place && !DELIVERY_ROW.test(description) && TOWN.test(place) && !names.has(nameKey(place));
  const staged = boeStage(description);
  return {
    ...clock,
    ...(kept ? { location: place.toUpperCase() } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** A day of the reply's own dates, or null when it gives none. */
function dayOf(payload: Record<string, unknown>, key: string): string | null {
  const value = text(payload, key, 20);
  if (!value) return null;
  const slashed = SLASHED_DAY.exec(value);
  const day = slashed ? calendarDay(Number(slashed[3]), Number(slashed[1]), Number(slashed[2])) : spelledDay(value);
  if (!day) invalid(`Best Overnite returned an invalid ${key}`);
  return day;
}

/**
 * The answer for a shipment without scans: the page then shows only its
 * status line. A delivery's names the day and time and who signed; the signer
 * is not kept. Any other line says nothing the adapter can stage.
 */
function summaryOf(payload: Record<string, unknown>, zone: string | null): CarrierResult {
  const delivered = DELIVERED_STATUS.exec(text(payload, 'status', 300));
  const day = delivered ? calendarDay(Number(delivered[3]), Number(delivered[1]), Number(delivered[2])) : null;
  if (!delivered || !day) throw new NoHistoryError(PROVIDER);
  const clock = clockOn(day, delivered[4]!, zone);
  return {
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
    last_status_text: 'Delivered', last_update: clock.time ?? null,
    ...(clock.local_time ? { last_update_local: clock.local_time } : {}),
    expected_delivery: null,
    ...(clock.time ? { delivered_at: clock.time } : {}),
    summary_only: true, events: [],
  };
}

/**
 * The reply of `api/Tracking/GetTrackingDetails` for one PRO number, the
 * lookup the tracking widget on bestovernite.com makes:
 * `{"proNum":…,"errorCode":…,"collHistories":[…],"objShipper":{…},"objConsignee":{…},…}`.
 * A number without a shipment comes back with the error `BADPRONBR` and the
 * number asked. A shipment must name the PRO number asked in `proNum`. Its
 * scans come oldest first. The reply also holds the shipper's and the
 * consignee's names and addresses, who signed, the bill of lading, purchase
 * order and pickup numbers, the pallet count and the ship and delivery days;
 * only the parties' states are read, to settle the clocks' zone, and none of
 * them is kept.
 */
export function parseBoe(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBoeNumber(raw);
  if (!isRecord(payload) || typeof payload.errorCode !== 'string' || typeof payload.proNum !== 'string') {
    invalid('Best Overnite returned an invalid tracking reply');
  }
  const error = clean(payload.errorCode, 40);
  const found = clean(payload.proNum, 40);
  if (error.toUpperCase() === NO_SHIPMENT) {
    if (found === number) throw new NotFoundError(PROVIDER);
    // The service names no number when it refuses one's form, which a whole PRO number never is.
    if (!found) invalid('Best Overnite refused the PRO number');
    throw new IndeterminateError(PROVIDER, 'Best Overnite answered for another number');
  }
  if (error) invalid('Best Overnite answered with an unknown error');
  if (found !== number) throw new IndeterminateError(PROVIDER, 'Best Overnite answered for another shipment');

  const rows = payload.collHistories ?? [];
  if (!Array.isArray(rows)) invalid('Best Overnite returned an invalid history');
  if (rows.length > MAX_ROWS) invalid('Best Overnite returned an oversized history');
  const zone = zoneOf(payload);
  const names = new Set([text(payload, 'signedBy', 120), text(record(payload, 'objShipper'), 'name', 120),
    text(record(payload, 'objConsignee'), 'name', 120)].map(nameKey).filter(Boolean));
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // Newest first; the reply lists the oldest first, as the page reverses it.
  for (const event of rows.map((row: unknown) => projectRow(row, zone, names)).reverse()) {
    const key = JSON.stringify([event.time ?? event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) return summaryOf(payload, zone);

  // A delivery ends the shipment, and a scan recorded after it moves nothing;
  // otherwise the newest staged scan decides.
  const newest = events[0]!;
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = delivery ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const settled = stage === 'delivered' || stage === 'returned';
  const estimate = dayOf(payload, 'estDeliveryDate');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged && stage ? { current_stage: stage, current_stage_source: staged.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: settled ? null : estimate,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    events,
  };
}
