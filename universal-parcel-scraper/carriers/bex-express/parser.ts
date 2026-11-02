import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bexCode, bexLabel, bexStage } from './status.js';

export const PROVIDER = 'BEX Express';
// A long history is a few kilobytes.
export const BEX_MAX_BYTES = 256 * 1024;
// Nine digits, as the tracking form's example and every shipment the service names.
const NUMBER = /^\d{9}$/;
// The scan's wall clock, to the second; a fraction of a second is dropped.
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
// `timeZone`, as "GMT+1", read the way the tracking page reads it.
const ZONE = /^GMT\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
// The service's answer, with HTTP 400, for a number it does not know.
const UNKNOWN = /^Shipment with provided trackingValue doesn't exist\b/i;
// A status the tracking page leaves out of the history it shows.
const HIDDEN_STATUS = -41;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for BEX Express's tracker, nine digits; anything else is not one it issues. */
export function normalizeBexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BEX Express shipment numbers are nine digits');
  return number;
}

/** Whether a reply is the service's own answer for a number it does not know. */
export function isBexUnknown(payload: unknown): boolean {
  return isRecord(payload) && !Object.hasOwn(payload, 'listShipmentHistory') && typeof payload.message === 'string'
    && UNKNOWN.test(payload.message.trim());
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `BEX Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A status or scan code, a whole number; a missing scan code is 0. */
function code(row: Record<string, unknown>, key: string, missing?: number): number {
  const value = row[key];
  if ((value === null || value === undefined) && missing !== undefined) return missing;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^-?\d{1,6}$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new SchemaError(PROVIDER, `BEX Express returned an invalid ${key}`);
  return parsed;
}

/** Whether a scan's `shipmentId`, a whole number, is the number asked. */
function sameShipment(value: unknown, number: string): boolean {
  const digits = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && /^\d{1,20}$/.test(value.trim()) ? value.trim() : null;
  if (digits === null) throw new SchemaError(PROVIDER, 'BEX Express returned a scan without its shipment');
  return digits.replace(/^0+(?=\d)/, '') === number.replace(/^0+(?=\d)/, '');
}

/** An offset in minutes, or null when it is none a clock can have. */
function offsetMinutes(sign: string, hours: string, minutes = '00'): number | null {
  const total = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  return Number(minutes) < 60 && total % 15 === 0 && total >= -12 * 60 && total <= 14 * 60 ? total : null;
}

/** The offset `timeZone` states for the scan's clock; null when it states none. */
function zoneMinutes(row: Record<string, unknown>): number | null {
  const match = ZONE.exec(text(row, 'timeZone', 40));
  return match ? offsetMinutes(match[1]!, match[2]!, match[3]) : null;
}

/**
 * A scan's time. `timeStamp` is a wall clock and `timeZone` its offset, as
 * "GMT+1": the API documentation gives it as the zone of the timestamp, and
 * the page reads the two together. A timestamp with its own offset keeps it,
 * as on the page; without a usable offset the wall clock stays local.
 */
function scanTime(row: Record<string, unknown>): { time: string } | { local_time: string } {
  const match = STAMP.exec(text(row, 'timeStamp', 40));
  const local = match?.[1] ?? '';
  const own = match?.[2];
  const minutes = own === 'Z' ? 0 : own ? offsetMinutes(own[0]!, own.slice(1, 3), own.slice(4)) : zoneMinutes(row);
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone: minutes === null ? 'UTC' : FixedOffsetZone.instance(minutes) }));
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || (own && minutes === null) || !parsed.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'BEX Express returned an invalid scan time');
  }
  const iso = minutes === null ? null : parsed.toISO({ suppressMilliseconds: true });
  return iso ? { time: iso } : { local_time: local };
}

function sortKey(event: CarrierEvent): number {
  return typeof event.time === 'string'
    ? DateTime.fromISO(event.time, { setZone: true }).toMillis()
    : DateTime.fromISO(event.local_time as string, { zone: 'UTC' }).toMillis();
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const status = code(row, 'statusCode');
  const scan = code(row, 'scanCode', 0);
  const providerCode = bexCode(status, scan);
  const description = clean(bexLabel(status, scan, text(row, 'statusName')), 200);
  if (!description) throw new SchemaError(PROVIDER, 'BEX Express returned a scan without wording');
  const when = scanTime(row);
  // The page shows a dash for a scan without a place.
  const location = text(row, 'statusLocation').replace(/^[\s\-–]+$/, '');
  const staged = bexStage(providerCode, description);
  const event: CarrierEvent = {
    ...when,
    ...(location ? { location } : {}),
    description,
    provider_code: providerCode,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([when, providerCode, location]), event };
}

/**
 * The reply of `Shipments/shipmentHistory` for one number: the scans, oldest
 * first, and `eventPrediction`, a summary of the recipient, the courier's
 * notes and the cash on delivery, which is not kept. Every scan must name the
 * number asked. The service answers a number it does not know with HTTP 400
 * and a message saying so.
 */
export function parseBex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBexNumber(raw);
  if (isBexUnknown(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'listShipmentHistory')) throw new SchemaError(PROVIDER, 'BEX Express returned an invalid envelope');
  const rows = payload.listShipmentHistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'BEX Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'BEX Express returned an oversized history');

  const seen = new Set<string>();
  const events: { event: CarrierEvent; index: number }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'BEX Express returned an invalid scan');
    if (!sameShipment(row.shipmentId, number)) throw new IndeterminateError(PROVIDER, 'BEX Express answered for another shipment');
    if (code(row, 'statusCode') === HIDDEN_STATUS) continue;
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push({ event: scan.event, index: events.length });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of two scans on one clock, the later in the reply is newer.
  const newestFirst = events
    .map(({ event, index }) => ({ event, index, key: sortKey(event) }))
    .sort((a, b) => b.key - a.key || b.index - a.index)
    .map(({ event }) => event);

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && typeof current!.time === 'string' ? current!.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
