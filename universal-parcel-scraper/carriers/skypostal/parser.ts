import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { skypostalStage } from './status.js';

export const PROVIDER = 'SkyPostal';
// A thirty-scan history is about thirty kilobytes sealed.
export const SKYPOSTAL_MAX_BYTES = 1024 * 1024;
// Letters and digits, eight or more, at least one digit: SkyPostal's own
// numbers, its waybills and the references of the partners it hands over to.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The tracker's answer for a number it does not know: "No information available".
const UNKNOWN_NUMBER = '10001';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Stages a delivery recorded earlier is not undone by.
const BEFORE_DELIVERY = new Set<Stage>(['pending', 'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery',
  'failed_attempt', 'ready_for_pickup']);

/** A number for SkyPostal's tracker, in capitals; anything else is not one it issues. */
export function normalizeSkypostalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyPostal numbers are eight or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SkyPostal returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock, `entry_date_str`, to the second. Most are the Miami
 * server's wall clock, but one destination partner's scans came twice, from
 * two feeds four hours apart, so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'entry_date_str', 32));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid scan time');
  }
  return local;
}

/** SkyPostal's waybill, the number its tracker keeps a shipment's scans under. */
function waybillOf(row: Record<string, unknown>): number {
  const value = row.trck_nmr_fol;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SchemaError(PROVIDER, 'SkyPostal returned a scan without its waybill');
  return value;
}

interface Scan { key: string; label: string; event: CarrierEvent }

/**
 * A scan as the page lists it: its code, its wording, the partner's town or
 * else SkyPostal's station, and its clock. The comments column, the proof of
 * delivery and the partner's own number are not kept.
 */
function scanOf(row: Record<string, unknown>): Scan {
  const code = text(row, 'track_cdg', 16).toUpperCase();
  const description = text(row, 'track_description', 160);
  if (!description) throw new SchemaError(PROVIDER, 'SkyPostal returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'event_locality', 120) || text(row, 'iata_code', 8).toUpperCase();
  const staged = skypostalStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), label: text(row, 'order_label', 64).toUpperCase(), event };
}

/** What a lookup read: the shipment's history, its waybill, and whether the reply itself names the number asked. */
export interface SkypostalReading {
  result: CarrierResult;
  waybill: number;
  named: boolean;
}

/**
 * The opened reply of the page's `asyncSingleTracking` lookup. A number the
 * tracker does not know comes back as one row with error 10001. The scans
 * belong to one waybill. A scan's `order_label` is the label the parcel then
 * travelled under, which is the number asked on some shipments' scans, and
 * the shipment is named when one of them, or the waybill, is the number.
 */
export function readSkypostal(payload: unknown, raw: string): SkypostalReading {
  const number = normalizeSkypostalNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.shipmentSearchSingle)) throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid envelope');
  const single = payload.shipmentSearchSingle;
  if (single.error !== null && single.error !== undefined) throw new IndeterminateError(PROVIDER, 'SkyPostal did not complete the lookup');
  const rows = single.data;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SkyPostal returned a lookup without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SkyPostal returned an oversized history');

  const errors: string[] = [];
  const waybills = new Set<number>();
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid scan');
    const error = row.error ?? {};
    if (!isRecord(error)) throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid scan error');
    const code = text(error, 'error_code', 16);
    if (code) {
      errors.push(code);
      continue;
    }
    waybills.add(waybillOf(row));
    const scan = scanOf(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) {
    // With no parcel scans the page opens its cargo view, for an air consignment.
    const cargo = payload.shipmentSearchSingleCargo;
    if (Array.isArray(cargo) && cargo.length) throw new IndeterminateError(PROVIDER, 'SkyPostal knows the number as an air consignment, not a parcel');
    if (rows.length === 1 && errors[0] === UNKNOWN_NUMBER) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'SkyPostal did not complete the lookup');
  }
  if (errors.length) throw new IndeterminateError(PROVIDER, 'SkyPostal did not complete the lookup');
  if (waybills.size > 1) throw new IndeterminateError(PROVIDER, 'SkyPostal answered with several shipments');
  const waybill = [...waybills][0]!;

  // Newest first, as the page lists them.
  const events = scans.map((scan) => scan.event)
    .sort((a, b) => (b.local_time as string).localeCompare(a.local_time as string));
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // A destination partner's scans can come twice, from feeds whose clocks
  // differ by hours, so an earlier stage after a delivery does not undo it.
  const delivered = events.find((event) => event.stage === 'delivered');
  const current = delivered && BEFORE_DELIVERY.has(staged?.stage as Stage) ? delivered : staged;
  const stage = current?.stage as Stage | undefined;
  return {
    waybill,
    named: String(waybill) === number || scans.some((scan) => scan.label === number),
    result: {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
      last_status_text: newest.description!,
      last_update: null,
      last_update_local: newest.local_time,
      expected_delivery: null,
      events: events.slice(0, MAX_EVENTS),
      ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    },
  };
}

/**
 * Whether the opened reply of the page's `shipmentSearchMultipleSkp` summary
 * names the number asked as the waybill's external number or current label.
 * Its `tracking_searched` only echoes the request.
 */
export function skypostalSummaryNames(payload: unknown, raw: string, waybill: number): boolean {
  const number = normalizeSkypostalNumber(raw);
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid summary');
  return payload.some((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SkyPostal returned an invalid summary row');
    return row.trck_nmr_fol === waybill && [text(row, 'external_tracking', 64), text(row, 'order_label', 64)]
      .some((label) => label.toUpperCase() === number);
  });
}
