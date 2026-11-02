import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dsvStage, isDsvEstimate } from './status.js';

export const PROVIDER = 'DSV';
// A search returns at most 100 shipments of a few kilobytes each.
export const DSV_MAX_BYTES = 1_000_000;

const MAX_SHIPMENTS = 100;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
// myDSV searches any run of letters and digits: shipment, booking and house bill numbers.
const NUMBER = /^(?=.*\d)[A-Z0-9]{5,40}$/;
// The shipment's key in myDSV's own requests. It opens the shipment's details, so it never leaves the adapter.
const KEY = /^[A-Za-z0-9-]{8,80}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
// Postcodes and street numbers in a place name.
const DIGITS = /\S*\d{3,}\S*/g;

/** myDSV takes letters and digits; dashes, spaces and dots are already gone. */
export function normalizeDsvNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'DSV tracks shipment, booking and house bill numbers of letters and digits');
}

/** The shipment ids DSV gives a shipment itself; references and partners' numbers are not among them. */
function ownIds(shipment: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const calculated: unknown[] = Array.isArray(shipment.calculatedShipmentId) ? shipment.calculatedShipmentId : [];
  for (const value of [shipment.mainTmsShipmentId, shipment.shipmentId, shipment.bookingId, ...calculated]) {
    const id = returnedTrackingNumber(value, true);
    if (id) ids.add(id);
  }
  return ids;
}

export interface DsvShipment {
  /** The key myDSV's own detail and history requests take. */
  readonly key: string;
  readonly mode: string;
  /** Whether the search result names the number as one of the shipment's own ids. */
  readonly own: boolean;
}

function shipmentOf(entry: Record<string, unknown>, own: boolean): DsvShipment {
  const key = typeof entry.randomIdentifier === 'string' ? entry.randomIdentifier : '';
  if (!KEY.test(key)) throw new SchemaError(PROVIDER, 'myDSV returned a shipment without its key');
  return { key, mode: clean(entry.modeOfTransport, 40).toUpperCase(), own };
}

/**
 * The public search's reply: every shipment whose ids or references match the
 * number. Only the shipment's ids, key and mode of transport are read; the
 * parties, addresses and references are not.
 */
export function pickDsvShipment(payload: unknown, rawNumber: string): DsvShipment {
  const number = normalizeDsvNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_SHIPMENTS
    || !payload.data.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'myDSV did not return a shipment list');
  }
  const entries = payload.data as Record<string, unknown>[];
  // Former DB Schenker shipments, and numbers searched without their dashes, are not in this search.
  if (!entries.length) throw new IndeterminateError(PROVIDER, 'myDSV\'s public search does not know the number', { reason: 'portal_not_found' });
  const own = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (ownIds(entry).has(number)) own.set(shipmentOf(entry, true).key, entry);
  }
  if (own.size === 1) return shipmentOf([...own.values()][0]!, true);
  if (own.size > 1) throw new IndeterminateError(PROVIDER, 'myDSV found several shipments for the number', { reason: 'several_parcels' });
  // The number may be the shipment's house bill, which only its details name.
  if (entries.length === 1) return shipmentOf(entries[0]!, false);
  throw new IndeterminateError(PROVIDER, 'The number matched only references of several DSV shipments', { reason: 'reference_only' });
}

/**
 * The shipment's details, asked only when the search matched it by something
 * other than its ids. A house bill number is DSV's own; a customer, order or
 * partner reference, or the airline's master bill, does not bind the shipment
 * to the number. Nothing else in the details is read.
 */
export function confirmDsvShipment(payload: unknown, rawNumber: string): void {
  const number = normalizeDsvNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'myDSV did not return the shipment');
  if (ownIds(payload).has(number) || returnedTrackingNumber(payload.houseBillNumber, true) === number) return;
  throw new IndeterminateError(PROVIDER, 'The number matched only a reference of a DSV shipment', { reason: 'reference_only' });
}

/** The row's clock ("2026-03-04T09:15:00") as a wall clock, or its day when DSV gives midnight. */
function clockOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) throw new SchemaError(PROVIDER, 'myDSV returned an invalid date');
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]}:${match[3] ?? '00'}`, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'myDSV returned an invalid date');
  // A booking or a planned date carries the day alone.
  return parsed.toFormat('HH:mm:ss') === '00:00:00' ? parsed.toFormat('yyyy-MM-dd') : parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** "Place, CC": the town or port and its country, without postcodes. */
function locationOf(value: unknown): string {
  if (!isRecord(value)) return '';
  const raw = clean(value.place, 120);
  const place = raw === '-' ? '' : clean(raw.replace(DIGITS, ' ')).replace(/^[\s,/-]+|[\s,/-]+$/g, '');
  const country = clean(value.countryCode, 2).toUpperCase();
  return [place, /^[A-Z]{2}$/.test(country) ? country : ''].filter(Boolean).join(', ');
}

interface Row {
  readonly code: string;
  readonly wording: string;
  readonly date: unknown;
  readonly dateTo: unknown;
  readonly location: unknown;
  readonly cancelled: boolean;
}

function codeOf(value: unknown): string {
  const code = cleanScalar(value, 40);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'myDSV returned a row without a code');
  return code;
}

/** A row of a milestone group in the shipment's history. */
function statusRow(value: unknown): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'myDSV returned an invalid history row');
  return { code: codeOf(value.eventCode), wording: clean(value.description, 300), date: value.eventDate,
    dateTo: value.eventDateTo, location: value.location, cancelled: value.cancelled === true };
}

/** A row of one port of the main carriage, placed at that port. */
function legRow(value: unknown, location: unknown): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'myDSV returned an invalid port row');
  return { code: codeOf(value.code), wording: clean(value.description, 300), date: value.date, dateTo: value.dateTo,
    location, cancelled: value.cancelled === true };
}

function list(value: unknown, what: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `myDSV returned invalid ${what}`);
  return value;
}

/**
 * The rows the shipment page lists. With port data, the groups before and
 * after the main carriage come from it, and each port lists its own
 * departures and arrivals. Without it, every group of the history is listed.
 * Earlier values of a row are kept only as its history, except for XPRESS
 * shipments, whose page lists them as rows of their own.
 */
function rowsOf(payload: Record<string, unknown>, mode: string): Row[] {
  const legData = isRecord(payload.legData) ? payload.legData : null;
  const groups = legData ? [...list(legData.firstEvents, 'history groups'), ...list(legData.lastEvents, 'history groups')]
    : list(payload.events, 'history groups');
  const rows: Row[] = [];
  for (const group of groups) {
    if (!isRecord(group)) throw new SchemaError(PROVIDER, 'myDSV returned an invalid history group');
    for (const child of list(group.children, 'history rows')) {
      rows.push(statusRow(child));
      if (mode === 'XPRESS' && isRecord(child)) rows.push(...list(child.children, 'history rows').map(statusRow));
    }
  }
  for (const leg of legData ? list(legData.legs, 'ports') : []) {
    if (!isRecord(leg)) throw new SchemaError(PROVIDER, 'myDSV returned an invalid port');
    rows.push(...list(leg.legEvents, 'port rows').map(row => legRow(row, leg.location)));
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'myDSV returned an unexpectedly long history');
  return rows;
}

interface Scan {
  readonly event: CarrierEvent;
  readonly index: number;
}

/**
 * The shipment's history from myDSV's status service: milestone groups whose
 * rows carry a date type, English wording, a wall clock and a place. Planned
 * and requested dates are estimates, not scans; the estimated delivery is the
 * delivery estimate until the shipment is delivered.
 */
export function parseDsvStatuses(payload: unknown, shipment: DsvShipment): CarrierResult {
  if (!isRecord(payload) || !(Array.isArray(payload.events) || payload.events === null)
    || !(isRecord(payload.legData) || payload.legData === null || payload.legData === undefined)) {
    throw new SchemaError(PROVIDER, 'myDSV did not return the shipment history');
  }
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let estimate: { from: string; to: string } | null = null;
  rowsOf(payload, shipment.mode).forEach((row, index) => {
    const time = clockOf(row.date);
    if (row.cancelled || !time) return;
    const description = row.wording || row.code;
    if (isDsvEstimate(row.code, description)) {
      // The group's current row comes before its earlier values.
      if (row.code === 'ESTIMATED_DELIVERY' && !estimate) {
        const from = time.slice(0, 10);
        const to = clockOf(row.dateTo)?.slice(0, 10) ?? from;
        estimate = { from, to: to < from ? from : to };
      }
      return;
    }
    const location = locationOf(row.location);
    const event: CarrierEvent = { local_time: time, description, provider_code: row.code, ...(location ? { location } : {}) };
    const classified = dsvStage(row.code, description);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
    // A row repeated for each container or part of the shipment counts once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, index });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'myDSV returned the shipment without a history', { reason: 'no_history' });
  // Newest first; rows at the same clock keep the reply's order.
  scans.sort((left, right) => {
    const a = left.event.local_time as string;
    const b = right.event.local_time as string;
    return b > a ? 1 : b < a ? -1 : left.index - right.index;
  });
  const events = scans.map(scan => scan.event);
  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  const expected = estimate as { from: string; to: string } | null;
  const pending = expected && stage !== 'delivered';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: pending ? expected.to : null,
    ...(pending && expected.from !== expected.to ? { expected_delivery_from: expected.from } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
