import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ycsRelayedPlace, ycsStage } from './status.js';

export const PROVIDER = 'YCS Logistics';
// A long history is a few kilobytes.
export const YCS_MAX_BYTES = 512 * 1024;
// A bill is eleven digits; a piece's number adds two.
const NUMBER = /^\d{11}(?:\d{2})?$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE = 'Asia/Taipei';
const MAX_PIECES = 99;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A YCS bill or piece number; anything else is not one it issues. */
export function normalizeYcsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YCS numbers are eleven or thirteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `YCS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock, which the page takes from `currentDate`, else `Date1` (when
 * it happened), else `Date2` (when it was entered). YCS works within Taiwan,
 * whose one zone keeps no daylight saving, so the clock is read in Taipei time.
 */
function scanTime(row: Record<string, unknown>): { time: string; at: number } {
  const value = row.currentDate ?? (row.Date1 || row.Date2);
  const parts = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const wall = parts ? `${parts[1]}T${parts[2]}` : '';
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parts || !zoned.isValid || zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'YCS returned an invalid scan time');
  }
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

interface Row { event: CarrierEvent; at: number; order: number; estimate: string }

/**
 * One scan: the label or sentence, the station in charge and the code. A row
 * HCT relays (`agents`) is placed at the branch its sentence names, not at the
 * YCS station that handed the parcel over. Who entered the scan is not kept.
 */
function projectRow(row: unknown, order: number): Row {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'YCS returned an invalid scan');
  const description = text(row, 'status_type');
  if (!description) throw new SchemaError(PROVIDER, 'YCS returned a scan without its status');
  const code = cleanScalar(row.code, 16);
  const agent = cleanScalar(row.agents, 8);
  const location = ycsRelayedPlace(description) ?? (agent && agent !== '0' ? '' : text(row, 'company', 60));
  const { time, at } = scanTime(row);
  const estimate = text(row, 'estimated_date', 16);
  const staged = ycsStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  // Parsing in UTC checks the calendar digits only; the day stays a local date.
  const day = DATE.test(estimate) && DateTime.fromISO(estimate, { zone: 'UTC' }).isValid ? estimate : '';
  return { event, at, order, estimate: day };
}

function scans(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, 'YCS returned a shipment with invalid scans');
  return value;
}

/**
 * The scans for the number asked. A bill of one piece lists them under
 * `status`, and its number may carry the piece's two digits. A bill of several
 * pieces lists each piece's under `batchs`, by piece number: the bill's number
 * gets them all, a piece's number its own.
 */
function rowsFor(entry: Record<string, unknown>, info: Record<string, unknown>, number: string): unknown[] {
  const bill = cleanScalar(info.systemNumber, 64);
  if (!/^\d+$/.test(bill)) throw new SchemaError(PROVIDER, 'YCS returned a shipment without its number');
  // The page reads 1 as one piece and any other answer as several.
  if (cleanScalar(entry.search_status, 8) === '1') {
    if (number !== bill && number !== `${bill}${cleanScalar(info.subSystemNumber, 8)}`) {
      throw new IndeterminateError(PROVIDER, 'YCS answered for another shipment');
    }
    return scans(entry.status);
  }
  const batches = entry.batchs;
  if (!isRecord(batches)) throw new SchemaError(PROVIDER, 'YCS returned a shipment without its scans');
  const pieces = Object.entries(batches);
  if (!pieces.length || pieces.length > MAX_PIECES || pieces.some(([piece]) => !new RegExp(`^${bill}\\d{2}$`).test(piece))) {
    throw new SchemaError(PROVIDER, 'YCS returned invalid pieces');
  }
  if (number === bill) return pieces.flatMap(([, rows]) => scans(rows));
  const piece = pieces.find(([key]) => key === number);
  if (!piece) throw new IndeterminateError(PROVIDER, 'YCS answered for another shipment');
  return scans(piece[1]);
}

/**
 * The reply of the tracking page's `/userSearchTrack` for one number: the
 * shipments found, by the number asked. A number YCS does not know gets
 * `search_status` 0, which the page reports as no such order number.
 */
export function parseYcs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYcsNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'YCS returned an invalid envelope');
  // The service's refusal of the request itself, which the page shows as an alert.
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'YCS did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'YCS returned an invalid list of shipments');
  if (!Object.hasOwn(data, number) || Object.keys(data).length !== 1) throw new IndeterminateError(PROVIDER, 'YCS answered for another number');
  const entry = data[number];
  if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'YCS returned an invalid shipment');
  if (cleanScalar(entry.search_status, 8) === '0') throw new NotFoundError(PROVIDER);

  const info = entry.info;
  if (!isRecord(info)) throw new SchemaError(PROVIDER, 'YCS returned a shipment without its details');
  const rows = rowsFor(entry, info, number);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'YCS returned an oversized history');
  const seen = new Set<string>();
  const projected = rows.map(projectRow).filter(({ event }) => {
    // A scan listed twice, or shared by the pieces of one bill, is kept once.
    const identity = JSON.stringify([event.time, event.description, event.location, event.provider_code]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (!projected.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the reply lists them oldest first.
  const sorted = projected.sort((a, b) => b.at - a.at || b.order - a.order);
  const events = sorted.map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const done = stage === 'delivered' || stage === 'returned';
  // The day a station expects to deliver, which YCS sets when it sends the parcel on.
  const estimate = done ? '' : sorted.find((row) => row.estimate)?.estimate ?? '';
  const sender = text(info, 'full_name', 120);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: estimate || null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    ...(sender ? { sender_name: sender } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
