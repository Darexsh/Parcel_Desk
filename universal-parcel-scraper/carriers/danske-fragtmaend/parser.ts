import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { danskeFragtmaendStage } from './status.js';

export const PROVIDER = 'Danske Fragtmænd';
// A long history is a few kilobytes.
export const DANSKE_FRAGTMAEND_MAX_BYTES = 512 * 1024;

const ZONE = 'Europe/Copenhagen';
// A consignment note number, and a parcel's collicode: twenty digits, then the note's number.
const CONSIGNMENT = /^[A-Z]{2}\d{6}$/;
const COLLICODE = /^\d{20}[A-Z]{2}\d{6}$/;
// "2026-05-27T10:58:21": a wall clock in Denmark, without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_ROWS = 500;
// Delivery windows the sender booked. The page blanks their date and words its own sentence.
const BOOKINGS = new Set(['DO1', 'DO2', 'DO3', 'DO4', 'SDL']);
// A scan this long before the consignment note's date belongs to an earlier note under the same number.
const REUSED_AFTER_DAYS = 30;

export interface DanskeFragtmaendNumber {
  number: string;
  kind: 'consignment' | 'colli';
}

/** A consignment note number or a collicode, in capitals; anything else is not a number Danske Fragtmænd issues. */
export function normalizeDanskeFragtmaendNumber(raw: string): DanskeFragtmaendNumber {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (CONSIGNMENT.test(number)) return { number, kind: 'consignment' };
  if (COLLICODE.test(number)) return { number, kind: 'colli' };
  throw new InvalidInputError(PROVIDER, 'Danske Fragtmænd numbers are a consignment note number or a collicode');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Danske Fragtmænd returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A wall clock's digits, calendar-checked, or null for a value that is not one. */
function wallClock(value: string): string | null {
  const local = CLOCK.exec(value)?.[1];
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  return local && parsed?.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? local : null;
}

function instant(wall: string): string {
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

/** One row of `ConsignmentNoteTraces`, or null for a booked delivery window. */
function scanOf(row: unknown): { wall: string; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned an invalid scan');
  const code = text(row, 'EventCode', 16).toUpperCase();
  if (BOOKINGS.has(code)) return null;
  const wall = wallClock(text(row, 'Date', 40));
  if (!wall) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned an invalid scan time');
  // The page shows the code when a scan has no wording.
  const description = text(row, 'EventCodeText', 300) || code;
  if (!description) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned a scan without wording');
  if (row.Status !== null && row.Status !== undefined && !Number.isInteger(row.Status)) {
    throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned an invalid scan status');
  }
  const location = text(row, 'Location', 120) || text(row, 'CargoHubDisplayText', 120);
  const staged = danskeFragtmaendStage(code, typeof row.Status === 'number' ? row.Status : null, description);
  return {
    wall,
    event: {
      time: instant(wall),
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** The total weight of the goods lines, each line's weight being the whole line's. */
function weightOf(goods: unknown): number | null {
  if (!Array.isArray(goods) || !goods.length) return null;
  let total = 0;
  for (const line of goods) {
    const weight = isRecord(line) ? line.Weight : undefined;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return null;
    total += weight;
  }
  return total <= 100_000 ? Math.round(total * 1000) / 1000 : null;
}

/** The collicodes the consignment lists, in capitals. */
function barcodesOf(goods: unknown): string[] {
  if (!Array.isArray(goods)) return [];
  return goods.flatMap((line) => (isRecord(line) && Array.isArray(line.ColliCodes) ? line.ColliCodes as unknown[] : []))
    .map((colli) => (isRecord(colli) ? clean(colli.Barcode, 64).toUpperCase() : ''))
    .filter(Boolean);
}

/**
 * The reply of `GetByConsignmentNumber` or `GetByColliCode`, the lookups the
 * tracking page makes: the consignment note and its scans, newest first. An
 * unknown number gets HTTP 404 instead, which the adapter reads.
 */
export function parseDanskeFragtmaend(payload: unknown, raw: string): CarrierResult {
  const { number, kind } = normalizeDanskeFragtmaendNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.ConsignmentNote)) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned an invalid reply');
  const note = payload.ConsignmentNote;
  if (typeof note.ConsignmentNumber !== 'string') throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned a consignment without its number');
  const consignment = clean(note.ConsignmentNumber, 64).toUpperCase();
  // A collicode ends with its consignment note's number, and the note lists its collicodes.
  const barcodes = kind === 'colli' ? barcodesOf(note.Goods) : [];
  if (consignment !== (kind === 'colli' ? number.slice(20) : number) || (barcodes.length && !barcodes.includes(number))) {
    throw new IndeterminateError(PROVIDER, 'Danske Fragtmænd answered for another consignment');
  }
  const rows = payload.ConsignmentNoteTraces ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned an oversized history');

  const dated = wallClock(text(note, 'ConsignmentDate', 40));
  const oldest = dated ? DateTime.fromISO(dated, { zone: 'UTC' }).minus({ days: REUSED_AFTER_DAYS }).toFormat("yyyy-MM-dd'T'HH:mm:ss") : '';
  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = scanOf(row);
    if (!scan || scan.wall < oldest) continue;
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan.event);
  }
  const cancelled = text(payload, 'State', 40) === 'Annulleret';
  if (!scans.length && !cancelled) throw new NoHistoryError(PROVIDER);
  const events = scans.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const latest = events[0];
  const current = events.find((event) => event.stage);
  // The page puts its cancellation notice over the scans of a cancelled consignment.
  const stage = (cancelled ? 'exception' : current?.stage) as Stage | undefined;
  const source = cancelled ? 'carrier_map' : current?.stage_source;
  const delivered = stage === 'delivered' ? current!.time : undefined;
  const settled = stage === 'delivered' || stage === 'returned' || cancelled;
  const delivery = isRecord(note.DeliveryTime) ? wallClock(text(note.DeliveryTime, 'ExpectedDeliveryDate', 40)) : null;
  const weight = weightOf(note.Goods);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: cancelled ? 'The shipment is cancelled' : latest!.description!,
    last_update: latest?.time ?? null,
    expected_delivery: !settled && delivery ? delivery.slice(0, 10) : null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(kind === 'colli' ? { canonical_tracking_number: consignment } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
