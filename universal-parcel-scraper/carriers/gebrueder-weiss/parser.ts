import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, explicitOffsetTime, isoTime, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gebruederWeissCode, gebruederWeissStage } from './status.js';

export const PROVIDER = 'Gebrüder Weiss';
// One page of up to twenty shipments, each with its status events.
export const GEBRUEDER_WEISS_MAX_BYTES = 1024 * 1024;

// Order numbers, request numbers and the sender's own references, in letters and digits.
const NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
const ZONE = 'Europe/Vienna';
const FAMILY = /^[A-Z][A-Z0-9]{1,9}$/;
const CODE = /^[A-Z0-9*]{1,10}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_ORDERS = 100;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
// The page's names for the shipment types.
const SERVICES: ReadonlyMap<string, string> = new Map([
  ['ROAD', 'Road'], ['AIR', 'Air'], ['SEA', 'Sea'], ['LCL', 'Sea LCL'], ['FCL', 'Sea FCL'],
  ['HOME_DELIVERY', 'Home Delivery'], ['PREMIUM', 'Premium'], ['RAIL', 'Rail'],
]);
// The estimate types the page labels as the arrival at the destination. The
// actual delivery time and arrivals at a port or airport are not estimates of the delivery.
const ESTIMATES: ReadonlySet<string> = new Set([
  'estimatedtimeofdelivery', 'estimatedtimeofdeliverycrplus', 'estimatedtimeofdeliverycrplus_lz07',
  'estimatedtimeofdeliverycrplus_lz09', 'indeliverymobcom', 'etaorderid', 'camionorderid', 'axaptahorderid',
  'tisorderid', 'axaptahdorderid',
]);
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

interface Scan {
  readonly event: CarrierEvent;
  readonly code: string;
  /** The labelled instant, as the service sends it. */
  readonly labelled: number;
  /** The instant the scan is ordered by: its own when placed, else the labelled one. */
  readonly at: number;
  readonly located: boolean;
  readonly index: number;
}

/** A number as the search takes it: letters and digits, without spaces, dots or hyphens. */
export function normalizeGebruederWeissNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Gebrüder Weiss numbers are 4 to 40 letters and digits');
  return number;
}

/** The sender's or recipient's postcode, which the search asks for beside the number. */
export function normalizeGebruederWeissPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) {
    throw new InputRequiredError(PROVIDER, 'the sender or recipient postcode',
      "Gebrüder Weiss shows a shipment only with its sender's or recipient's postcode");
  }
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'Gebrüder Weiss requires a valid postcode');
  return postcode;
}

/** Whether a shipment carries the number as its order number, request number or one of its references. */
function carries(order: Record<string, unknown>, number: string): boolean {
  const references: unknown[] = Array.isArray(order.customer_reference) ? order.customer_reference : [];
  return [order.order_id, order.request_order_id, ...references]
    .some((value) => returnedTrackingNumber(value, true) === number);
}

/** The branch a scan happened at, as "Town, AT", and its country. */
function placeOf(location: unknown): { name: string; country: string | null } {
  if (!isRecord(location)) return { name: '', country: null };
  const code = clean(location.countryCode, 10).toUpperCase();
  const country = COUNTRY.test(code) ? code : null;
  return { name: [clean(location.description, 80), country].filter(Boolean).join(', '), country };
}

/**
 * When a scan happened. The service labels every clock as UTC, and its
 * branches' clocks are true instants. A branch in a zone whose clock differs
 * from Vienna's sends its own wall clock, which the service reads as Vienna
 * time, so it is read again in that country's zone, or kept as a wall clock
 * when the country keeps several zones. A scan without a place keeps its instant.
 */
function clockOf(labelled: ParsedTime, country: string | null): { time: string } | { local_time: string } {
  if (!country) return { time: labelled.iso };
  const zone = countryTimeZone(country);
  const vienna = DateTime.fromMillis(labelled.timestamp, { zone: ZONE });
  if (zone) {
    const local = DateTime.fromMillis(labelled.timestamp, { zone });
    if (local.offset === vienna.offset) return { time: local.toISO({ suppressMilliseconds: true })! };
  }
  const wall = vienna.toISO({ includeOffset: false, suppressMilliseconds: true })!;
  const placed = zone ? isoTime(wall, zone) : null;
  return placed ? { time: placed.iso } : { local_time: wall };
}

/** One status event, or null for one the page hides as internal. */
function scanOf(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned an invalid status event');
  if (row.isInternal === true) return null;
  const family = clean(row.event, 20);
  const eventCode = cleanScalar(row.eventCode, 20);
  const reason = cleanScalar(row.reasonCode, 20);
  const labelled = explicitOffsetTime(row.eventDateTime);
  if ((family && !FAMILY.test(family)) || !CODE.test(eventCode) || (reason && !CODE.test(reason)) || !labelled) {
    throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned a status event without its code or clock');
  }
  const code = gebruederWeissCode(family, eventCode, reason);
  const place = placeOf(row.location);
  const clock = clockOf(labelled, place.country);
  const placed = 'time' in clock ? explicitOffsetTime(clock.time) : null;
  const event: CarrierEvent = { ...clock, description: clean(row.description, 300) || code, provider_code: code,
    ...(place.name ? { location: place.name } : {}) };
  return { event, code, labelled: labelled.timestamp, at: placed?.timestamp ?? labelled.timestamp,
    located: Boolean(place.name), index };
}

/**
 * The scans of one shipment, newest first. The page hides internal events.
 * The service records many events twice, once at the branch and once without
 * a place minutes later; the second is dropped, and so are identical rows.
 */
function scansOf(rows: readonly unknown[]): Scan[] {
  const scans = rows.map(scanOf).filter((scan): scan is Scan => scan !== null);
  const twin = (scan: Scan) => `${scan.labelled}|${scan.code}`;
  const located = new Set(scans.filter((scan) => scan.located).map(twin));
  const seen = new Set<string>();
  return scans.filter((scan) => {
    if (!scan.located && located.has(twin(scan))) return false;
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((left, right) => right.at - left.at || left.index - right.index);
}

/** The shipment's estimated arrival at its destination, as the calendar day the page shows. */
function estimateOf(order: Record<string, unknown>): string | null {
  if (!ESTIMATES.has(clean(order.estimated_time_of_arrival_type, 80).toLowerCase())) return null;
  const estimate = explicitOffsetTime(order.estimated_time_of_arrival);
  return estimate ? DateTime.fromMillis(estimate.timestamp, { zone: ZONE }).toISODate() : null;
}

/**
 * The public search's reply: a page of the shipments that match the number
 * and the postcode, each with its status events. The search matches the
 * number in several references, so the shipment is the one whose order
 * number, request number or a sender's reference is the whole number.
 * Addresses, names, customer numbers, partner references, remarks, the CO2
 * figures, documents and the internal German wording are never read.
 */
export function parseGebruederWeiss(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGebruederWeissNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.payload) || typeof payload.totalRows !== 'number') {
    throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned an unexpected reply');
  }
  const orders = payload.payload as unknown[];
  if (orders.length > MAX_ORDERS || !orders.every(isRecord)) throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned an invalid shipment list');
  if (!orders.length) {
    if (payload.totalRows !== 0) throw new IndeterminateError(PROVIDER, 'Gebrüder Weiss returned an empty page of shipments');
    // An unknown number, a wrong postcode and a shipment older than the search's window look alike.
    throw new NotFoundError(PROVIDER, 'Gebrüder Weiss found no shipment for this number and postcode');
  }
  const bound = (orders as Record<string, unknown>[]).filter((order) => carries(order, number));
  if (!bound.length) throw new IndeterminateError(PROVIDER, 'Gebrüder Weiss matched the number only in another reference');
  if (bound.length > 1) throw new IndeterminateError(PROVIDER, 'Gebrüder Weiss found several shipments for this number');
  const order = bound[0]!;

  const rows = order.detail_status_transport ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Gebrüder Weiss returned an invalid shipment history');
  const scans = scansOf(rows);
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Oldest first: once the goods are sent back, every later movement is the way back.
  let returning = false;
  for (const scan of [...scans].reverse()) {
    const classified = gebruederWeissStage(scan.code, scan.event.description!);
    if (!classified) continue;
    const stage: Stage = returning && classified.stage !== 'exception' ? 'returned' : classified.stage;
    if (classified.stage === 'returned') returning = true;
    Object.assign(scan.event, { stage, stage_source: classified.source });
  }
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const expected = stage && SETTLED.has(stage) ? null : estimateOf(order);
  const weight = order.gross_weight_unit === 'KGM' && typeof order.gross_weight === 'number'
    && Number.isFinite(order.gross_weight) && order.gross_weight > 0 ? order.gross_weight : null;
  const service = SERVICES.get(clean(order.shipment_type, 40).toUpperCase());
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(stage === 'delivered' && decider!.time ? { delivered_at: decider!.time } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
