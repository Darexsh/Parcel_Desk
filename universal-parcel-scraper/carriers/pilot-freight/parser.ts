import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pilotStage } from './status.js';

export const PROVIDER = 'Pilot Freight Services';
// A shipment with a few line items and a dozen events is a few kilobytes.
export const PILOT_MAX_BYTES = 256 * 1024;
// A pro number is nine digits, the only form the tracking page looks up.
const NUMBER = /^\d{9}$/;
// A clock as the reply writes it: a wall time to the second, with the offset of the service's zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
// The year the reply gives a clock it does not have.
const UNSET = '0001';
// The answer for a pro number the service has no shipment under.
const NOT_FOUND = 'ERROR_102';
// The place of an event recorded by phone or online, which names no town.
const NO_PLACE = /^ON-?LINE\s*\/\s*ON PHONE$/i;
// States split between zones, whose name does not settle a clock.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
const POUNDS_TO_KG = 0.453_592_37;
const MAX_SHIPMENTS = 10;
const MAX_ROWS = 500;
const MAX_LINES = 200;
const MAX_EVENTS = 100;

/** A Pilot pro number, as typed; anything else is not one its tracker looks up. */
export function normalizePilotNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pilot pro numbers are nine digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`Pilot returned an invalid ${key}`);
  return value;
}

/** An optional list: absent is empty, anything but an array is a changed reply. */
function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid(`Pilot returned an invalid ${key}`);
  if (value.length > max) invalid(`Pilot returned an oversized ${key}`);
  return value as unknown[];
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Pilot returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Clock {
  readonly wall: string;
  readonly day: string;
  /** The instant, when the clock's offset is the one its place keeps then. */
  readonly time: string | null;
}

/**
 * The zone of a place in a US state that keeps one clock throughout. A place
 * outside the US, or in a state split between zones, has none.
 */
function zoneOf(state: string, country: string): string | null {
  if (country && country !== 'US') return null;
  return SPLIT_STATES.has(state) ? null : usStateTimeZone(state);
}

/**
 * A clock of the reply, or null when it has none. Every clock carries the
 * offset of the service's own zone, Eastern time, whatever it records: an
 * event entered in Eastern time, a delivery written in the recipient's local
 * time, an appointment's hours. The offset is trusted only where it is the
 * one the place's zone keeps at that instant, which reads the same either way;
 * elsewhere the clock stays a wall clock.
 */
function clockOf(row: Record<string, unknown>, key: string, zone: string | null): Clock | null {
  const value = text(row, key, 40);
  if (!value || value.startsWith(UNSET)) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid(`Pilot returned an invalid ${key}`);
  const [, year, month, date, hour, minute, second, offset] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // Luxon accepts hour 24, so the clock's fields are checked here.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid(`Pilot returned an invalid ${key}`);
  const wall = `${day}T${hour}:${minute}:${second}`;
  const read = offset && zone ? DateTime.fromISO(`${wall}${offset}`, { setZone: true }) : null;
  const kept = read?.isValid && read.offset === read.setZone(zone!).offset;
  return { wall, day, time: kept ? read.toISO({ suppressMilliseconds: true }) : null };
}

/** The wording as the tracking page prints it: each word capitalized. */
function titleCase(value: string): string {
  return value.toLowerCase().split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** An event's place: its town and state, and its country outside the US. Its ZIP code is not kept. */
function placeOf(location: Record<string, unknown>): { place: string; zone: string | null } {
  const town = text(location, 'City', 80);
  const state = text(location, 'StateProvince', 8).toUpperCase();
  const country = text(location, 'CountryCode', 8).toUpperCase();
  if (!town || NO_PLACE.test(town)) return { place: '', zone: null };
  const parts = [titleCase(town), state, country && country !== 'US' ? country : ''].filter(Boolean);
  return { place: parts.join(', '), zone: zoneOf(state, country) };
}

/**
 * One event of `TrackingEventHistory`: its `EventCode`, `EventCodeDesc`,
 * `EventType1`, clock and place. Who signed for the shipment
 * (`SignedForByName`) and where it was left (`AdditionalLocationInfo`) are not
 * read.
 */
function projectRow(row: unknown): CarrierEvent {
  if (!isRecord(row)) invalid('Pilot returned an invalid event');
  const code = text(row, 'EventCode', 16).toUpperCase();
  const wording = text(row, 'EventCodeDesc', 160);
  if (!code || !wording) invalid('Pilot returned an event without its status');
  const { place, zone } = placeOf(record(row, 'EventLocation'));
  const clock = clockOf(row, 'EventDateTime', zone);
  if (!clock) invalid('Pilot returned an event without its time');
  const description = titleCase(wording);
  const staged = pilotStage(code, text(row, 'EventType1', 8), description);
  return {
    ...(clock.time ? { time: clock.time } : { local_time: clock.wall }),
    ...(place ? { location: place } : {}),
    description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The shipment's weight, the sum of its line items' pounds, in kilograms. */
function weightOf(info: Record<string, unknown>): number | null {
  let pounds = 0;
  for (const line of list(info, 'LineItemList', MAX_LINES)) {
    if (!isRecord(line)) invalid('Pilot returned an invalid line item');
    const weight = line.WeightLbs;
    if (weight === null || weight === undefined) continue;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) invalid('Pilot returned an invalid weight');
    pounds += weight;
  }
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The delivery estimate, which the reply gives and the page does not show:
 * `EstimateDelvDate`, from the start of the appointment when the appointment
 * ends then. An appointment that ends at another time, such as a pickup's,
 * is not the delivery's. Its clocks are the destination's local hours under
 * the service's offset, so they are instants only in a state whose zone keeps
 * that offset, and days elsewhere.
 */
function estimate(info: Record<string, unknown>): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const consignee = record(info, 'PackageConsignee');
  const zone = zoneOf(text(consignee, 'StateProvince', 8).toUpperCase(), text(consignee, 'CountryCode', 8).toUpperCase());
  const due = clockOf(info, 'EstimateDelvDate', zone);
  if (!due) return { expected_delivery: null };
  const start = clockOf(info, 'AppointmentStartDate', zone);
  const end = clockOf(info, 'AppointmentEndDate', zone);
  const window = start && end?.wall === due.wall && start.wall < due.wall ? start : null;
  if (due.time && window?.time) return { expected_delivery: due.time, expected_delivery_from: window.time };
  if (due.time && !window) return { expected_delivery: due.time };
  return { expected_delivery: due.day, ...(window && window.day < due.day ? { expected_delivery_from: window.day } : {}) };
}

/** The reply's shipment for the pro number asked, or the error it gives instead. */
function shipmentOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.TrackingResponse)) invalid('Pilot returned an invalid tracking reply');
  const entries: unknown[] = payload.TrackingResponse;
  if (!entries.length || entries.length > MAX_SHIPMENTS) invalid('Pilot returned an invalid tracking reply');
  let other = false;
  let unknown = false;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.TrackingInfo) || typeof entry.TrackingInfo.TrackingNumber !== 'string') {
      invalid('Pilot returned a shipment without its pro number');
    }
    const info = entry.TrackingInfo;
    const found = clean(info.TrackingNumber, 40);
    if (found === number) return info;
    const error = record(record(entry, 'TrackingErrorInfo'), 'TrackingErrorDetail');
    if (found) other = true;
    else if (text(error, 'ErrorDetailCode', 40).toUpperCase() === NOT_FOUND) unknown = true;
  }
  if (other) throw new IndeterminateError(PROVIDER, 'Pilot answered for another shipment');
  if (unknown) throw new NotFoundError(PROVIDER);
  // An empty shipment without the service's answer for an unknown pro number says nothing.
  throw new IndeterminateError(PROVIDER, 'Pilot answered without a shipment');
}

/**
 * The reply of `wwwapi.pilotdelivers.com/track/{pro in base64}/orgzip/0/dstzip/0/custnum/0`,
 * the lookup Maersk's ground freight tracker makes:
 * `{"TrackingResponse":[{"TrackingInfo":{…},"TrackingErrorInfo":{…},…}]}`.
 * A pro number it has no shipment under comes back as an empty shipment with
 * the error `ERROR_102` ("NO TRACKING INFO FOUND"). The shipment must name the
 * pro number asked. It also holds the shipper and the consignee, whose names,
 * addresses and phones are masked but whose towns are not, the references,
 * the goods' description, the dimensions and piece counts, the stations'
 * contacts, the proof of delivery's signer and document link and the billing
 * account; none of them is kept.
 */
export function parsePilot(payload: unknown, raw: string): CarrierResult {
  const number = normalizePilotNumber(raw);
  const info = shipmentOf(payload, number);
  const rows = list(info, 'TrackingEventHistory', MAX_ROWS);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const event of rows.map(projectRow)) {
    const key = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // Events come newest first. A delivery ends the shipment, and an event recorded after it
  // moves nothing; otherwise the newest staged event decides.
  const newest = events[0]!;
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = delivery ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const settled = stage === 'delivered' || stage === 'returned';
  const service = titleCase(text(info, 'Service', 80));
  const weight = weightOf(info);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged && stage ? { current_stage: stage, current_stage_source: staged.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(settled ? { expected_delivery: null } : estimate(info)),
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
