import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fastfrateStage } from './status.js';

export const PROVIDER = 'Fastfrate';
// A long timeline is a few kilobytes.
export const FASTFRATE_MAX_BYTES = 128 * 1024;
// A probill as the trackers take it: more than five digits, as the tracker's page checks, and
// at most ten, as the former page's field. The service reads it as a number, so one starting
// with 0 would not be the same digits.
const NUMBER = /^[1-9]\d{5,9}$/;
// "2026-03-03T15:58:00", with milliseconds on some rows: a wall clock without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// Two rows are not scans. The page shows the estimate's day over the list and leaves its row
// out, and an appointment's row is dated with the appointment's own time.
const ESTIMATE = 'estimated delivery date';
const APPOINTMENT = 'scheduled appointment';
// A canonical province or territory code.
const PROVINCE = /^[A-Z]{2}$/;
// Stages a delivery settles: the driver's device stamps its rows on its own clock, so its
// arrival at the consignee can come after the delivery.
const BEFORE_DELIVERY = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery']);
const MAX_ROWS = 300;

/** A Fastfrate probill: six to ten digits. Anything else is not one the tracker is asked for. */
export function normalizeFastfrateNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fastfrate probills are six to ten digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, `Fastfrate returned ${message}`);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A row's wall clock to the second, or its day when the clock is midnight, which the
 * timeline gives a row dated without a time. No clock names its zone.
 */
function clockOf(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) invalid('an invalid timeStamp');
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid('an invalid timeStamp');
  return `${hour}${minute}${second}` === '000000' ? day : `${day}T${hour}:${minute}:${second}`;
}

/** A terminal's town and province; a town holding a digit could be an address, so it is left out. */
function placeOf(row: Record<string, unknown>): string {
  const city = text(row, 'city', 80);
  const province = text(row, 'province', 8).toUpperCase();
  if (!city || /\d/.test(city)) return '';
  return PROVINCE.test(province) ? `${city}, ${province}` : city;
}

interface Row { wording: string; clock: string; place: string }

function rowOf(value: unknown): Row {
  if (!isRecord(value)) invalid('an invalid timeline row');
  const wording = text(value, 'description');
  if (!wording) invalid('a timeline row without its description');
  return { wording, clock: clockOf(value.timeStamp), place: placeOf(value) };
}

/**
 * The reply of `trackerapi/shipmentinformation/quicktrack?probillnumber={number}`, the lookup
 * the tracker's quick track page makes: `{"probillNumber":…,"timeline":[…],"references":[…],
 * "serviceMsg":…}`, the timeline oldest first. The page reports an empty timeline as not
 * found. The references are the shipper's own, and the service message stands in for a
 * missing estimate; neither is read.
 */
export function parseFastfrate(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFastfrateNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.timeline)) invalid('an invalid envelope');
  const probill = payload.probillNumber;
  if (typeof probill !== 'number' || !Number.isSafeInteger(probill) || probill < 0) invalid('a reply without its probill');
  // The service answers for the number it read: a missing one reads as 0, whose record holds stray rows.
  if (String(probill) !== number) throw new IndeterminateError(PROVIDER, 'Fastfrate answered for another probill');
  const rows: unknown[] = payload.timeline;
  if (rows.length > MAX_ROWS) invalid('an oversized timeline');
  if (!rows.length) throw new NotFoundError(PROVIDER);

  let estimate: string | null = null;
  let appointment: string | null = null;
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const value of rows) {
    const row = rowOf(value);
    const wording = normalizeStatusWording(row.wording);
    // The page shows the first estimate row's day.
    if (wording === ESTIMATE) {
      estimate ??= row.clock.slice(0, 10);
      continue;
    }
    if (wording === APPOINTMENT) {
      appointment = row.clock.slice(0, 10);
      continue;
    }
    const key = JSON.stringify([row.clock, row.wording, row.place]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = fastfrateStage(row.wording);
    events.push({
      local_time: row.clock,
      ...(row.place ? { location: row.place } : {}),
      description: row.wording,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows on the same clock keep the reply's order, the later one first.
  events.sort((a, b) => (a.local_time === b.local_time ? 0 : String(a.local_time) < String(b.local_time) ? -1 : 1)).reverse();

  // The newest staged row decides, except that the driver's arrival at the shipper never steps
  // a shipment back, and a delivery settles the rows its stages come before.
  const staged = events.filter((event) => event.stage);
  const newest = staged.find((event) => event.stage !== 'registered') ?? staged[0];
  const delivered = staged.find((event) => event.stage === 'delivered');
  const decided = delivered && newest && BEFORE_DELIVERY.has(newest.stage as Stage) ? delivered : newest;
  const stage = decided?.stage as Stage | undefined;
  const done = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: stage, current_stage_source: decided.stage_source } : {}),
    last_status_text: (decided ?? events[0]!).description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    // The appointment's day, else the estimate's, until the delivery.
    expected_delivery: done ? null : appointment ?? estimate,
    events,
  };
}
