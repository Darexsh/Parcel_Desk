import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  IndeterminateError,
  InputRequiredError,
  InvalidInputError,
  NoHistoryError,
  NotFoundError,
  SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fedexFreightStage } from './status.js';

export const PROVIDER = 'FedEx Freight';
// A shipment's reply is about fifteen kilobytes.
export const FEDEX_FREIGHT_MAX_BYTES = 1024 * 1024;

// A PRO number is ten digits, leading zeros included.
const NUMBER = /^\d{10}$/;
// The codes the tracker gives FedEx Freight; anything else is another FedEx service.
const FREIGHT_CARRIERS = new Set(['FXFR', 'FDFR']);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
// A shipment the page shows only to a signed-in recipient or the shipper's account.
const GATED = new Set(['TRACKING.AUTHORIZATION.ERROR', 'TRACKING.ACCOUNTNUMBER.MISMATCH']);
const POUNDS_TO_KG = 0.453_592_37;
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_PACKAGES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A PRO number as the tracker takes it; any other input is a number FedEx Freight does not issue. */
export function normalizeFedexFreightNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FedEx Freight PRO numbers are ten digits');
  return number;
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `FedEx Freight returned an invalid ${key}`);
  return typeof value === 'string' ? clean(value, maxLength) : cleanScalar(value, maxLength);
}

/** An optional flag: absent is false, anything but a boolean is a changed reply. */
function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new SchemaError(PROVIDER, `FedEx Freight returned an invalid ${key}`);
  return value;
}

/** An optional array, bounded; anything else is a changed reply. */
function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new SchemaError(PROVIDER, `FedEx Freight returned an invalid ${key}`);
  return value;
}

function day(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * A scan's clock: `date`, `time` and `gmtOffset`, as the page assembles
 * them. With its offset it is an instant; without one it stays a wall clock.
 * Anything else is a changed reply. Luxon accepts hour 24, so it is refused.
 */
function scanClock(scan: Record<string, unknown>): { time: string; timestamp: number } | { local_time: string; timestamp: number } {
  const date = text(scan, 'date', 16);
  const time = text(scan, 'time', 16);
  const offset = text(scan, 'gmtOffset', 8);
  const clock = CLOCK.exec(time);
  const wall = `${date}T${time}`;
  if (day(date) && clock && Number(clock[1]) <= 23) {
    if (OFFSET.test(offset)) {
      const parsed = explicitOffsetTime(`${wall}${offset}`);
      if (parsed) return { time: parsed.iso, timestamp: parsed.timestamp };
    } else if (!offset) {
      // Read in UTC only to order it; the wall clock keeps no zone.
      const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
      if (parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall) return { local_time: wall, timestamp: parsed.toMillis() };
    }
  }
  throw new SchemaError(PROVIDER, 'FedEx Freight returned an invalid scan time');
}

/**
 * A scan's wording: its status, then its details. A delivery keeps its status
 * alone, since the person who signed is read nowhere.
 */
function wording(status: string, details: string, delivered: boolean): string {
  if (!details || delivered || status.toLowerCase().includes(details.toLowerCase())) return status;
  return status ? `${status}: ${details}` : details;
}

interface Row { event: CarrierEvent; timestamp: number }

/** One scan: its clock, wording, code and the terminal's or customer's town. The signee is never read. */
function rowOf(scan: unknown): Row {
  if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'FedEx Freight returned an invalid scan');
  const code = text(scan, 'statusCD', 8).toUpperCase();
  const exceptionCode = text(scan, 'statusExceptionCode', 16);
  const delivered = code === 'DL' || flag(scan, 'delivered');
  const description = wording(text(scan, 'status', 200), text(scan, 'scanDetails', 300), delivered);
  if (!description) throw new SchemaError(PROVIDER, 'FedEx Freight returned a scan without its wording');
  const { timestamp, ...clock } = scanClock(scan);
  const location = text(scan, 'scanLocation', 120);
  const staged = fedexFreightStage(code, exceptionCode, description);
  return {
    event: {
      ...clock, ...(location ? { location } : {}), description, ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    timestamp,
  };
}

/** The estimate the page shows, as a calendar day. */
function estimate(shipment: Record<string, unknown>): string | null {
  return day(text(shipment, 'estDeliveryDt', 32).slice(0, 10));
}

/** The shipment's total weight, in kilograms, from its pounds. */
function weight(shipment: Record<string, unknown>): number | null {
  const pounds = Number(text(shipment, 'totalLbsWgt', 16));
  return Number.isFinite(pounds) && pounds > 0 && pounds < 1_000_000 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/** The destination's country code, never the rest of the consignee's address. */
function destinationCountry(shipment: Record<string, unknown>): string | null {
  const address = shipment.recipientAddress;
  if (!isRecord(address)) return null;
  const country = text(address, 'countryCode', 4).toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

/** The package that answers the requested PRO, or the error the reply amounts to. */
function shipmentFor(payload: unknown, number: string): Record<string, unknown> {
  const output = isRecord(payload) ? payload.output : undefined;
  if (!isRecord(output) || !Array.isArray(output.packages)) throw new SchemaError(PROVIDER, 'FedEx Freight returned an unexpected reply');
  if (output.packages.length > MAX_PACKAGES) throw new SchemaError(PROVIDER, 'FedEx Freight returned too many shipments');
  // The page reads an empty answer as no results, but the service gives the
  // same answer to a value it refuses, so it proves nothing about the PRO.
  if (output.packages.length === 0) throw new IndeterminateError(PROVIDER, 'FedEx Freight returned no shipment for the PRO number');
  const matches = output.packages.filter((entry) => {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'FedEx Freight returned an invalid shipment');
    return text(entry, 'trackingNbr', 64) === number;
  }) as Record<string, unknown>[];
  if (matches.length === 0) throw new IndeterminateError(PROVIDER, 'FedEx Freight answered for another number');
  // The page asks which one is meant; picking one could show someone else's freight.
  if (matches.length > 1) throw new IndeterminateError(PROVIDER, 'FedEx Freight returned several shipments for the PRO number');
  const shipment = matches[0]!;
  const codes = list(shipment, 'errorList', 20).map((error) => {
    if (!isRecord(error)) throw new SchemaError(PROVIDER, 'FedEx Freight returned an invalid error');
    return text(error, 'code', 80).toUpperCase();
  }).filter(Boolean);
  // The page asks the visitor to sign in for these, whatever else the package says.
  if (codes.some((code) => GATED.has(code))) {
    throw new InputRequiredError(PROVIDER, 'recipient verification', 'FedEx Freight shows this shipment only to a signed-in recipient');
  }
  // The page reports a package it flags this way, without a qualifier, as not found or as an invalid number.
  const notFound = flag(shipment, 'notFound');
  const invalid = flag(shipment, 'invalid');
  if (!text(shipment, 'trackingQualifier', 64)) {
    if (invalid) throw new InvalidInputError(PROVIDER, 'FedEx Freight does not take this PRO number', { reason: 'wrong_number' });
    if (notFound) throw new NotFoundError(PROVIDER);
  }
  if (codes.length > 0) throw new IndeterminateError(PROVIDER, 'FedEx Freight returned an error for the PRO number');
  if (notFound || invalid) throw new IndeterminateError(PROVIDER, 'FedEx Freight returned a shipment it also flags as missing');
  // The tracker answers other FedEx services too; their history is not FedEx Freight's to give.
  if (!FREIGHT_CARRIERS.has(text(shipment, 'trackingCarrierCd', 8).toUpperCase())) {
    throw new IndeterminateError(PROVIDER, 'FedEx Freight answered for another FedEx service');
  }
  return shipment;
}

/**
 * The reply of the tracking page's `track-shipments` call for one PRO number:
 * `output.packages` holds the shipments it found, each with its summary and
 * its scans newest first. The shipper, consignee and receiver, the signee,
 * addresses, references, bills of lading and coordinates are never read.
 */
export function parseFedexFreight(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFedexFreightNumber(raw);
  const shipment = shipmentFor(payload, number);

  const rows: Row[] = [];
  const seen = new Set<string>();
  list(shipment, 'scanEventList', MAX_ROWS).forEach((scan) => {
    const row = rowOf(scan);
    const key = JSON.stringify(row.event);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });
  // Newest first by clock; scans stamped alike keep the reply's order.
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  rows.sort((left, right) => right.timestamp - left.timestamp);
  const events = rows.map((row) => row.event);

  const summaryCode = text(shipment, 'keyStatusCD', 8).toUpperCase();
  const summaryText = text(shipment, 'keyStatus', 200);
  if (events.length === 0) {
    if (!summaryText) throw new NoHistoryError(PROVIDER);
    const staged = fedexFreightStage(summaryCode, '', summaryText);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: summaryText,
      ...(summaryCode ? { provider_code: summaryCode } : {}),
      last_update: null,
      expected_delivery: staged && FINAL.has(staged.stage) ? null : estimate(shipment),
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const service = text(shipment, 'serviceDesc', 80);
  const kilograms = weight(shipment);
  const country = destinationCountry(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: stage && FINAL.has(stage) ? null : estimate(shipment),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
