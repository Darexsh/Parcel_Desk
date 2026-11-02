import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gtaAirskipMappedStage, gtaAirskipStage } from './status.js';

export const PROVIDER = 'GTA AirSkip';
// A long history is a few kilobytes.
export const GTA_AIRSKIP_MAX_BYTES = 512 * 1024;
// GRG for Ground or GRS for Select, five digits, then eleven letters or digits.
const NUMBER = /^GR[GS]\d{5}[0-9A-Z]{11}$/;
// A scan's clock, to the second or a fraction of it, with an offset only if the reply gives one.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,7}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?$/;
// Scans the tracking page hides from the public history.
const HIDDEN = new Set(['discard', 'discarded', 'manual', 'reject', 'rejected']);
// Older scans put the terminal's town and province before their reason, as "Sampleville, ON. Normal Status".
const PLACE_FIRST = /^([^,\d]{2,60},\s*[A-Z]{2})\.\s*(.*)$/;
// Scan types that report a problem, whose reason the page shows in their description.
const PROBLEM = new Set(['warning', 'error']);
const POUNDS_TO_KG = 0.453_592_37;
const MAX_SHIPMENTS = 30;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GTA AirSkip number, in capitals; anything else is not one GTA AirSkip issues. */
export function normalizeGtaAirskipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GTA AirSkip numbers are GRG or GRS, five digits and eleven letters or digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GTA AirSkip returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A `StandardStatus`, a nonnegative integer, as text; none when the reply has none. */
function standardStatus(row: Record<string, unknown>): string {
  const value = row.StandardStatus;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid StandardStatus');
}

/**
 * A scan's `EventDateTime`: a wall clock without a zone. The tracking page
 * reads it as UTC and the page before it showed it as it is, and scans fit
 * neither reading throughout, so it stays local. An offset, if the reply ever
 * gives one, makes it an instant.
 */
function scanClock(row: Record<string, unknown>): { wall: string; clock: string; time?: string } {
  const raw = text(row, 'EventDateTime', 40);
  const match = CLOCK.exec(raw);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Scans are ordered by the fraction too; the wall clock keeps whole seconds.
  const clock = `${wall}.${(match?.[3] ?? '').padEnd(7, '0')}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid scan time');
  }
  if (!match[4]) return { wall, clock };
  const instant = explicitOffsetTime(raw);
  if (!instant) throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid scan time');
  return { wall, clock, time: instant.iso };
}

/**
 * A scan's place and the reason its description gives. Terminal scans name
 * the town and province in `Location`, or in older scans before the reason in
 * `Description`. A place with a digit, which could be an address or
 * a postcode, is not kept.
 */
function placeAndReason(row: Record<string, unknown>): { location: string; reason: string } {
  let location = text(row, 'Location', 120).replace(/[\s.]+$/, '');
  let reason = text(row, 'Description', 200);
  const placed = location ? null : PLACE_FIRST.exec(reason);
  if (placed) {
    location = placed[1]!;
    reason = placed[2]!;
  }
  return { location: /\d/.test(location) ? '' : location, reason };
}

/**
 * A scan's wording: its name, and for a problem the reason its description
 * gives when the name does not hold it, as "Undelivered: Customer not
 * available". A reason with a digit is left out, as it could hold an address
 * or a phone number; the description of any other scan is not read.
 */
function wording(row: Record<string, unknown>, reason: string): string {
  const name = text(row, 'Name', 160) || text(row, 'Category', 80);
  if (!name) throw new SchemaError(PROVIDER, 'GTA AirSkip returned a scan without its name');
  const problem = PROBLEM.has(text(row, 'Type', 40).toLowerCase());
  if (!problem || !reason || /\d/.test(reason) || /^normal status$/i.test(reason) || name.toLowerCase().includes(reason.toLowerCase())) return name;
  return `${name}: ${reason}`;
}

interface Scan { event: CarrierEvent; wall: string; clock: string; order: number }

function scanOf(row: Record<string, unknown>, order: number): Scan {
  const code = standardStatus(row);
  const { location, reason } = placeAndReason(row);
  const description = wording(row, reason);
  const { wall, clock, time } = scanClock(row);
  const staged = gtaAirskipStage(code, description);
  return {
    event: {
      ...(time ? { time } : { local_time: wall }),
      description,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    wall,
    clock,
    order,
  };
}

const isHidden = (row: Record<string, unknown>) => HIDDEN.has(text(row, 'Name', 160).toLowerCase());

/** The reply's one shipment whose `TrackingNumber` is the number asked. */
function shipmentFor(data: unknown[], number: string): Record<string, unknown> {
  const matching = data.filter((entry) => {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid shipment');
    const tracking = text(entry, 'TrackingNumber', 64);
    if (!tracking) throw new SchemaError(PROVIDER, 'GTA AirSkip returned a shipment without its number');
    return normalizeTrackingNumber(tracking) === number;
  }) as Record<string, unknown>[];
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'GTA AirSkip answered for another shipment');
  return matching[0]!;
}

/** The parcel's weight in kilograms, from the pounds or kilograms the reply names. */
function weightKg(shipment: Record<string, unknown>): number | undefined {
  const value = shipment.Weight;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) return undefined;
  const unit = text(shipment, 'UOMWeight', 16).toLowerCase();
  const kg = /^lbs?$/.test(unit) ? value * POUNDS_TO_KG : /^kgs?$/.test(unit) ? value : undefined;
  return kg === undefined ? undefined : Math.round(kg * 1000) / 1000;
}

/** The estimate's calendar day, which is what the page shows of it. */
function estimate(shipment: Record<string, unknown>): string | null {
  const day = DAY.exec(text(shipment, 'EstimatedDeliveryDate', 40))?.[1];
  return day && DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/**
 * The reply of `trackings/track-my-package`, the lookup the tracking page
 * makes, for one number: `{"Data":[…],"IsSuccess":true}`. An empty `Data` is
 * the page's "Shipment Not Found". The shipment must name the number asked.
 * The shipper's and consignee's names, addresses and towns, references, scan
 * coordinates and proof-of-delivery links are never read.
 */
export function parseGtaAirskip(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGtaAirskipNumber(raw);
  if (!isRecord(payload) || typeof payload.IsSuccess !== 'boolean') throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid envelope');
  if (!payload.IsSuccess) throw new IndeterminateError(PROVIDER, 'GTA AirSkip could not complete the lookup');
  const data = payload.Data;
  if (!Array.isArray(data) || data.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid shipment list');
  if (!data.length) throw new NotFoundError(PROVIDER);
  const shipment = shipmentFor(data, number);
  const rows = shipment.Events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GTA AirSkip returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GTA AirSkip returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  let lastHidden = false;
  for (const [order, row] of rows.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GTA AirSkip returned an invalid scan');
    lastHidden = isHidden(row);
    if (lastHidden) continue;
    const scan = scanOf(row, order);
    const { provider_code: code, description, location } = scan.event;
    // The reply can repeat a scan a fraction of a second apart.
    const key = JSON.stringify([scan.wall, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by clock; the reply lists scans oldest first, so scans of one moment keep its order.
  const events = scans.sort((a, b) => (a.clock < b.clock ? 1 : a.clock > b.clock ? -1 : b.order - a.order)).map(({ event }) => event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The page takes the shipment's standard status for its own, unless the reply's last scan is one it hides.
  const code = lastHidden ? '' : standardStatus(shipment);
  const summary = code ? gtaAirskipMappedStage(code, '') : undefined;
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const service = text(shipment, 'Service', 60);
  const weight = weightKg(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(shipment),
    ...(/[A-Z]/i.test(service) && !/^n\/a$/i.test(service) ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
