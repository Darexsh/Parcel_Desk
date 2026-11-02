import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { DATA_RECORD_CODE, spsStage } from './status.js';

export const SPS = 'Slovak Parcel Service';
// A shipment's reply is a few kilobytes: its parcels and their scans.
export const SPS_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

// The forms SPS's own tracker validates for its parcels (mySPS `packageRegexes`):
// the parcel number (703, Slovakia's code, a depot and a serial), the label's
// barcode with two digits more, the depot and serial without the country, and
// the SK label code. Partner networks' numbers on that list are theirs.
const PARCEL = /^703\d{11}$/;
const BARCODE = /^703\d{11}[0-4]\d$/;
const LOCAL = /^[0-9A-Z]\d{10}$/;
const LABEL = /^SK[A-HJ-NP-Z0-9]{5}\d{2}[A-HJ-NP-Z0-9]{9}$/;

/** An SPS parcel number in the compact form its tracking service accepts. */
export function normalizeSpsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (![PARCEL, BARCODE, LOCAL, LABEL].some(pattern => pattern.test(number))) {
    throw new InvalidInputError(SPS, 'Slovak Parcel Service numbers are 703 and eleven digits, its sixteen-digit barcode, eleven characters without 703, or an SK label code');
  }
  return number;
}

/** The fourteen-digit parcel number a 703 form names; null for other forms. */
function parcelOf(id: string): string | null {
  if (PARCEL.test(id)) return id;
  if (BARCODE.test(id)) return id.slice(0, 14);
  return /^\d{11}$/.test(id) ? `703${id}` : null;
}

/**
 * Whether a number the reply gives names the requested parcel: the same
 * number, or a shorter form of the same barcode. Two barcodes must agree in full.
 */
export function samePackage(requested: string, id: string): boolean {
  if (requested === id) return true;
  const parcel = parcelOf(requested);
  return parcel !== null && parcel === parcelOf(id) && !(BARCODE.test(requested) && BARCODE.test(id));
}

function invalid(message = 'Slovak Parcel Service returned an unexpected tracking reply'): never {
  throw new SchemaError(SPS, message);
}

/** An optional text field; an object, array or other non-scalar is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return cleanScalar(value, maxLength);
  if (typeof value !== 'string') invalid(`Slovak Parcel Service returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A number the reply names, compact; empty when absent. */
function idOf(row: Record<string, unknown>, key: string): string {
  return normalizeTrackingNumber(text(row, key, 64));
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]{0,20})?$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,7}))?)?$/;

interface Scan {
  readonly event: CarrierEvent & { local_time: string; description: string };
  readonly parcel: string;
  readonly stage?: Stage;
  /** The wall clock with its fraction, which orders scans of the same second. */
  readonly order: string;
}

/**
 * One row of `statuses`. Its remark, event remark, references and the
 * handheld's coordinates are never read.
 */
function scanOf(row: unknown): Scan {
  if (!isRecord(row)) invalid();
  const day = DAY.exec(text(row, 'date', 32));
  const clock = CLOCK.exec(text(row, 'time', 32));
  if (!day || !clock || !calendarDay(Number(day[1]), Number(day[2]), Number(day[3]))) {
    invalid('Slovak Parcel Service returned an invalid scan clock');
  }
  const raw = row.statusCodeX;
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(code) || code < 0 || code > 9999) invalid('Slovak Parcel Service returned a scan without its code');
  const description = text(row, 'status');
  if (!description) invalid('Slovak Parcel Service returned a scan without wording');
  // The electronic data record is filed by SPS's billing department, which is no place the parcel was.
  const location = code === DATA_RECORD_CODE ? '' : text(row, 'center', 120);
  const stage = spsStage(code);
  const local = `${day[1]}-${day[2]}-${day[3]}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}`;
  return {
    event: { description, local_time: local, ...(location ? { location } : {}), provider_code: String(code),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
    parcel: idOf(row, 'parcelNumber'),
    ...(stage ? { stage } : {}),
    order: `${local}.${(clock[4] ?? '').padEnd(7, '0')}`,
  };
}

function rowsOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) invalid();
  return value;
}

/** The parcels a reply lists, each a record with its number. */
function parcelsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const parcels = rowsOf(payload.parcels);
  if (!parcels.every(isRecord)) invalid();
  return parcels;
}

/**
 * The parcel whose own scans the website asks for when a shipment comes
 * without them: one with a dashed parcel number, the requested one first.
 * Null when the reply has scans or no such parcel.
 */
export function spsParcelStatusTarget(payload: unknown, raw: string): string | null {
  const number = normalizeSpsNumber(raw);
  if (!isRecord(payload) || rowsOf(payload.statuses).length) return null;
  const dashed = parcelsOf(payload).map(parcel => text(parcel, 'parcelNumber', 64)).filter(id => id.includes('-'));
  return dashed.find(id => samePackage(number, normalizeTrackingNumber(id))) ?? dashed[0] ?? null;
}

/** The rows of a `parcel-status` reply for `parcel`, which must all name that parcel. */
export function parseSpsParcelStatus(payload: unknown, parcel: string): unknown[] {
  if (!isRecord(payload) || payload.ok !== true) invalid();
  const rows = rowsOf(payload.statuses);
  const target = normalizeTrackingNumber(parcel);
  for (const row of rows) {
    const id = isRecord(row) ? idOf(row, 'parcelNumber') : '';
    if (id && !samePackage(target, id) && !samePackage(id, target)) invalid('Slovak Parcel Service returned another parcel’s scans');
  }
  return rows;
}

/**
 * The reply of `GET /api/tracking/shipment`. The shipment, each parcel and
 * each scan name their numbers; one of them must be the requested parcel or
 * the barcode it is short for. The shipper, receiver, receiver's name,
 * destination postcode, references, remarks and the handheld's coordinates in
 * the same reply are never read. `rows` replaces the reply's scans with those
 * a `parcel-status` request returned.
 */
export function parseSpsShipment(payload: unknown, raw: string, rows?: readonly unknown[]): CarrierResult {
  const number = normalizeSpsNumber(raw);
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.shipment)) invalid();
  const shipment = payload.shipment;
  const parcels = parcelsOf(payload);
  const shipmentNumber = idOf(shipment, 'shipmentNumber');
  if (!shipmentNumber) invalid('Slovak Parcel Service returned a shipment without its number');
  const ids = [shipmentNumber, idOf(shipment, 'barcode'), ...parcels.map(parcel => idOf(parcel, 'parcelNumber'))].filter(Boolean);
  if (!ids.some(id => samePackage(number, id))) invalid('Slovak Parcel Service returned a different shipment');

  const all = (rows ?? rowsOf(payload.statuses)).map(scanOf);
  // A parcel of a shipment with several keeps its own scans when they are named.
  const own = all.filter(scan => scan.parcel && samePackage(number, scan.parcel));
  const named = new Set(all.map(scan => scan.parcel).filter(Boolean));
  const chosen = named.size > 1 && own.length ? own : all;
  // The shipment's parcels can repeat one scan; only exact copies go.
  const seen = new Set<string>();
  const scans = chosen.filter(scan => {
    const key = JSON.stringify(scan.event);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  // The service lists scans newest first; equal clocks keep its order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => (left.order === right.order ? 0 : left.order < right.order ? 1 : -1));

  const weight = shipment.weight;
  const weightKg = typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight < 10_000 ? { weight_kg: weight } : {};
  const newest = scans[0];
  if (!newest) {
    // A shipment without scans keeps the status the service gives it.
    const summary = text(shipment, 'status', 120);
    if (!summary) throw new IndeterminateError(SPS, 'Slovak Parcel Service returned the shipment without a status');
    const code = shipment.statusCode;
    const stage = typeof code === 'number' && Number.isInteger(code) ? spsStage(code) : undefined;
    return { status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: summary, last_update: null, ...(typeof code === 'number' ? { provider_code: String(code) } : {}),
      expected_delivery: null, summary_only: true, ...weightKg, events: [] };
  }
  // Cash and notice steps move nothing: the newest milestone stays current.
  // From a return to the sender on, a later delivery hands the parcel back.
  const staged = scans.filter(scan => scan.stage);
  const stage: Stage | undefined = staged.some(scan => scan.stage === 'returned') ? 'returned' : staged[0]?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.event.description,
    last_update: null,
    last_update_local: newest.event.local_time,
    expected_delivery: null,
    ...weightKg,
    events: scans.slice(0, MAX_EVENTS).map(scan => scan.event),
    ...(scans.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The search's notice for a number SPS does not know. */
export const SPS_NOT_FOUND_TITLE = 'Zásielku sa nám nepodarilo nájsť';

/**
 * The website search's answer (`GET /api/tracking/find-shipment`) after the
 * shipment request failed upstream. A 404 with the not-found notice is an
 * unknown number; the address of the shipment's page means SPS knows it and
 * only its history failed. Anything else proves nothing.
 */
export function parseSpsSearch(status: number, payload: unknown): never {
  if (status === 404 && isRecord(payload) && typeof payload.title === 'string' && clean(payload.title, 200) === SPS_NOT_FOUND_TITLE) {
    throw new NotFoundError(SPS, 'Slovak Parcel Service has no record of the shipment');
  }
  if (status === 200 && isRecord(payload) && typeof payload.url === 'string') {
    throw new IndeterminateError(SPS, 'Slovak Parcel Service knows the shipment but did not return its history');
  }
  throw new IndeterminateError(SPS, 'Slovak Parcel Service did not confirm the shipment');
}
