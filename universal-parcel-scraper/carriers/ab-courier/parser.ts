import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { abCourierStage } from './status.js';

export const PROVIDER = 'A&B Courier';
// An order's reply is under a kilobyte.
export const AB_COURIER_MAX_BYTES = 64 * 1024;

// An order number: archived lookups show seven digits. The tracker reads the
// number as a whole 32-bit number, so it has no leading zero and ends at 2147483647.
const NUMBER = /^[1-9]\d{6,9}$/;
const MAX_ORDER = 2_147_483_647;
// A clock of the dispatch system to the minute, "Jan 31 2023  3:39PM": the day and the hour padded with spaces.
const DISPATCH_CLOCK = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{4}) +(\d{1,2}):(\d{2})([AP]M)$/;
// The estimate, "02/01/2023 12:35:00": month, day and a 24-hour clock.
const ESTIMATE_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The day a database gives a clock it does not have.
const UNSET_YEAR = 1900;
// The reply's answer for an order the tracker does not have, which names no number.
const NOT_FOUND = /^Not able to find this order on our server\.?$/i;
const FOUND = 200;
const MISSING = 300;
// The partners the page links to by the driver an order is handed to, with the reference it links with.
const CANPAR_DRIVERS = new Set([910]);
const PUROLATOR_DRIVERS = new Set([903, 955, 956, 957]);
const FEDEX_DRIVERS = new Set([917, 918, 919]);
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;
const POUNDS_TO_KG = 0.453_592_37;
const COUNTRIES: Readonly<Record<string, string>> = { CAN: 'CA', USA: 'US' };
const ZONE = 'America/Toronto';
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);

/** An A&B order number. Anything else is not one the tracker is asked for. */
export function normalizeAbCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || Number(number) > MAX_ORDER) {
    throw new InvalidInputError(PROVIDER, 'A&B Courier order numbers are seven to ten digits, up to 2147483647, without a leading zero');
  }
  return number;
}

function invalid(message = 'A&B Courier returned an unexpected reply'): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. The reply writes a missing status as "null". */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`A&B Courier returned an invalid ${key}`);
  const cleaned = clean(value, maxLength);
  return cleaned === 'null' ? '' : cleaned;
}

/** A whole number the reply gives as a number or as digits; null when absent. */
function whole(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) invalid(`A&B Courier returned an invalid ${key}`);
  return number;
}

/** A wall clock from its fields, or null when they are not a real day and time. */
function wall(year: number, month: number, day: number, hour: number, minute: number, second = 0): string | null {
  const date = calendarDay(year, month, day);
  // Date libraries accept hour 24, so the fields are checked here.
  if (!date || hour > 23 || minute > 59 || second > 59) return null;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

/** A dispatch clock as a wall clock, or null without one. */
function dispatchClock(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value) return null;
  const match = DISPATCH_CLOCK.exec(value);
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  const hour = Number(match?.[4]);
  if (!match || !month || hour < 1 || hour > 12) invalid(`A&B Courier returned an invalid ${key}`);
  if (Number(match[3]) <= UNSET_YEAR) return null;
  const read = wall(Number(match[3]), month, Number(match[2]), (hour % 12) + (match[6] === 'PM' ? 12 : 0), Number(match[5]));
  if (!read) invalid(`A&B Courier returned an invalid ${key}`);
  return read;
}

/** The estimate as a wall clock, or null without one. */
function estimateClock(row: Record<string, unknown>): string | null {
  const value = text(row, 'estimatedDeliveryBy', 40);
  if (!value) return null;
  const match = ESTIMATE_CLOCK.exec(value);
  if (!match) invalid('A&B Courier returned an invalid estimatedDeliveryBy');
  if (Number(match[3]) <= UNSET_YEAR) return null;
  const read = wall(Number(match[3]), Number(match[1]), Number(match[2]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (!read) invalid('A&B Courier returned an invalid estimatedDeliveryBy');
  return read;
}

/**
 * A wall clock as an instant in Toronto when the order stays in Ontario, the
 * dispatch office's clock; else, or for an hour the clocks skip, as it is.
 */
function clockAt(read: string, zoned: boolean): { time: string } | { local_time: string } {
  if (!zoned) return { local_time: read };
  const instant = firstOccurrence(DateTime.fromISO(read, { zone: ZONE }));
  if (!instant.isValid || instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== read) return { local_time: read };
  return { time: instant.toISO({ suppressMilliseconds: true }) };
}

/** A town and its province; a town holding a digit could be a street, so it is left out. */
function placeOf(row: Record<string, unknown>, side: 'pickup' | 'delivery'): string {
  const town = text(row, `${side}City`, 60);
  const province = text(row, `${side}Province`, 4).toUpperCase();
  return [/\d/.test(town) ? '' : town, /^[A-Z]{2}$/.test(province) ? province : ''].filter(Boolean).join(', ');
}

/** Whether both ends of the order are in Ontario, the dispatch office's province. */
function inOntario(detail: Record<string, unknown>): boolean {
  return (['pickup', 'delivery'] as const).every((side) => text(detail, `${side}Province`, 4).toUpperCase() === 'ON'
    && text(detail, `${side}Country`, 4).toUpperCase() === 'CAN');
}

/** The reference the page links a partner's tracking with: whole, and not the zero A&B gives its own orders. */
function partnerNumber(detail: Record<string, unknown>, key: string): string {
  const value = text(detail, key, 60).toUpperCase().replace(/[\s-]/g, '');
  return PARTNER_NUMBER.test(value) && !/^0+$/.test(value) ? value : '';
}

/**
 * The partner the page sends the visitor to, "Track directly on …", by the
 * driver the order is handed to: Canpar with its barcode, Purolator and FedEx
 * with their waybill.
 */
function handoff(detail: Record<string, unknown>, stage: Stage | undefined): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  // The page links no partner for a cancelled order.
  if (stage === 'exception') return {};
  const driver = whole(detail, 'currentDriverNumber');
  if (driver === null) return {};
  const [carrier, key] = CANPAR_DRIVERS.has(driver) ? ['canpar', 'childTrackingBarcodes']
    : PUROLATOR_DRIVERS.has(driver) ? ['purolator', 'waybillNumber']
      : FEDEX_DRIVERS.has(driver) ? ['fedex', 'waybillNumber'] : ['', ''];
  const number = carrier ? partnerNumber(detail, key) : '';
  return number ? { delivery_carrier: carrier, delivery_tracking_number: number } : {};
}

/** The order's total weight, which the page shows in pounds, in kilograms. */
function weightOf(detail: Record<string, unknown>): number | null {
  const value = text(detail, 'totalWeight', 12);
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(value) || !Number(value)) return null;
  return Math.round(Number(value) * POUNDS_TO_KG * 1000) / 1000;
}

/** The picture over the page: its step and the status it shows. */
function pictureOf(payload: Record<string, unknown>): { step: string; wording: string } {
  const images: unknown = payload.trackingImages;
  if (images === null || images === undefined) return { step: '', wording: '' };
  if (!Array.isArray(images) || images.length > 10) invalid('A&B Courier returned invalid status pictures');
  const first: unknown = images[0];
  if (first === undefined) return { step: '', wording: '' };
  if (!isRecord(first)) invalid('A&B Courier returned an invalid status picture');
  return { step: text(first, 'trackingImageName', 40), wording: text(first, 'customerDescription', 120) };
}

function milestone(clock: { time: string } | { local_time: string }, location: string, description: string, stage: Stage): CarrierEvent {
  return { ...clock, ...(location ? { location } : {}), description, stage, stage_source: 'carrier_map' };
}

/**
 * The reply of `ABWebclientAPI/V1/Auth/TrackingInfo`, the lookup the tracking
 * page makes for an order number: `{"statusCode":200,"statusDescription":
 * "Success","trackingDtl":{…},"packageDetails":[…],"trackingImages":[…]}`.
 * `trackingDtl` is the order's summary: its status, the pickup and delivery
 * towns, the service, the scheduled pickup, the pickup and delivery clocks,
 * the estimate, the total weight and the driver. The page puts the status's
 * step and wording in a picture over the summary. There is no history. An
 * order it does not have is `statusCode` 300 with "Not able to find this order
 * on our server.". The signer, the driver, the boxes and their sizes are not
 * read.
 */
export function parseAbCourier(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAbCourierNumber(raw);
  if (!isRecord(payload)) invalid('A&B Courier returned an invalid envelope');
  const code = whole(payload, 'statusCode');
  const answer = text(payload, 'statusDescription', 200);
  if (code === MISSING && NOT_FOUND.test(answer)) throw new NotFoundError(PROVIDER);
  if (code === null || !answer) invalid('A&B Courier returned an envelope without its answer');
  if (code !== FOUND || answer !== 'Success') throw new IndeterminateError(PROVIDER, 'A&B Courier could not answer for the order');
  const detail = payload.trackingDtl;
  if (!isRecord(detail)) invalid('A&B Courier returned an order without its details');
  const order = whole(detail, 'orderNo');
  if (order === null) invalid('A&B Courier returned an order without its number');
  if (String(order) !== number) throw new IndeterminateError(PROVIDER, 'A&B Courier answered for another order');

  const status = text(detail, 'status');
  const picture = pictureOf(payload);
  const staged: ClassifiedWording | null = abCourierStage(status, picture.step) ?? abCourierStage(picture.wording);
  const stage = staged?.stage;
  const zoned = inOntario(detail);
  const pickup = dispatchClock(detail, 'pickedUpTime');
  const delivery = dispatchClock(detail, 'deliveredTime');
  // The page shows the pickup's clock once the order is picked up, and the delivery's once it is delivered.
  const pickedUp = stage !== undefined && stage !== 'registered' && stage !== 'exception';
  const events: CarrierEvent[] = [];
  if (stage === 'delivered' && delivery) events.push(milestone(clockAt(delivery, zoned), placeOf(detail, 'delivery'), 'Delivered', 'delivered'));
  if (pickedUp && pickup) events.push(milestone(clockAt(pickup, zoned), placeOf(detail, 'pickup'), 'Picked Up', 'accepted'));
  const wording = picture.wording || status;
  if (!wording && !events.length) throw new NoHistoryError(PROVIDER);

  // The status has a clock only when it is the delivery or the pickup itself.
  const own = events.find((event) => event.stage === stage && (stage === 'delivered' || stage === 'accepted'));
  const decided = staged ?? (events[0] ? { stage: events[0].stage as Stage, source: 'carrier_map' } : null);
  const estimate = decided && SETTLED.has(decided.stage) ? null : estimateClock(detail);
  const expected = estimate ? clockAt(estimate, zoned) : null;
  const delivered = events.find((event) => event.stage === 'delivered');
  const service = text(detail, 'serviceType', 80);
  const kilograms = weightOf(detail);
  const country = COUNTRIES[text(detail, 'deliveryCountry', 4).toUpperCase()];
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: wording || null,
    last_update: own?.time ?? null,
    ...(own?.local_time ? { last_update_local: own.local_time } : {}),
    expected_delivery: expected ? ('time' in expected ? expected.time : expected.local_time.slice(0, 10)) : null,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(country ? { destination_country: country } : {}),
    ...handoff(detail, decided?.stage),
    summary_only: true,
    events,
  };
}
