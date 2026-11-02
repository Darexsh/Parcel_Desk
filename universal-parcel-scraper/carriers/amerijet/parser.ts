import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { amerijetStage } from './status.js';

export const PROVIDER = 'Amerijet';
// A full history is about three kilobytes.
export const AMERIJET_MAX_BYTES = 256 * 1024;

// Amerijet's airline prefix, then the eight-digit serial.
const NUMBER = /^810\d{8}$/;
// The answer the tracking page reports as "AWB does not exist.".
const UNKNOWN = /^AWB does not exist\.?$/i;
const DATE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const TWELVE_HOUR = /^(0?[1-9]|1[0-2]):([0-5]\d) ?([AP]M)$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * An Amerijet air waybill: the prefix 810 and an eight-digit serial whose last
 * digit is the remainder of the first seven divided by seven, the IATA check.
 */
export function normalizeAmerijetNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || !hasMod7CheckDigit(number.slice(3))) {
    throw new InvalidInputError(PROVIDER, 'Amerijet air waybills are 810 and eight digits ending in the air waybill check digit');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Amerijet returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock, as the page shows it: the day of `TMEVENTDATE` and the
 * 12-hour `TMEVENTTIME`, else the time of `TMEVENTDATE`. The page heads the
 * column "local time": each station's wall clock, with no zone.
 */
function wallClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'TMEVENTDATE', 40));
  if (!date) throw new SchemaError(PROVIDER, 'Amerijet returned an invalid scan time');
  const twelveHour = text(row, 'TMEVENTTIME', 16);
  let clock = date[2]!;
  if (twelveHour) {
    const time = TWELVE_HOUR.exec(twelveHour);
    if (!time) throw new SchemaError(PROVIDER, 'Amerijet returned an invalid scan time');
    const hour = Number(time[1]) % 12 + (time[3]!.toUpperCase() === 'PM' ? 12 : 0);
    clock = `${String(hour).padStart(2, '0')}:${time[2]}:00`;
  }
  const local = `${date[1]}T${clock}`;
  // Parsing in UTC checks the calendar alone; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Amerijet returned an invalid scan time');
  }
  return local;
}

/** A piece count the reply gives, or null without one. */
function pieces(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, `Amerijet returned an invalid ${key}`);
  return value;
}

interface Scan { key: string; rank: number; event: CarrierEvent }

function projectRow(row: Record<string, unknown>, number: string): Scan {
  const awb = cleanScalar(row.TMAWB, 32);
  if (!awb) throw new SchemaError(PROVIDER, 'Amerijet returned a scan without its air waybill');
  if (normalizeTrackingNumber(awb) !== number) throw new IndeterminateError(PROVIDER, 'Amerijet answered for another air waybill');
  const code = text(row, 'TMEVENTSTATUSCODE', 40);
  const wording = text(row, 'TMEVENTDESC') || code;
  if (!wording) throw new SchemaError(PROVIDER, 'Amerijet returned a scan without wording');
  // The page's pieces column; a scan that moved part of the shipment says so.
  const moved = pieces(row, 'TMNUMBEROFPIECES');
  const total = pieces(row, 'TMTOTALPIECES');
  const description = moved !== null && total !== null && moved < total ? `${wording} (${moved} of ${total} pieces)` : wording;
  const local = wallClock(row);
  const station = text(row, 'TMSTATION', 40);
  const staged = amerijetStage(code, wording);
  const event: CarrierEvent = {
    local_time: local,
    ...(station ? { location: station } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  // The reply's own milestone order orders scans the same wall clock lists together.
  const rank = typeof row.OrderBy === 'number' && Number.isFinite(row.OrderBy) ? row.OrderBy : 0;
  return { key: JSON.stringify([local, code, description, station]), rank, event };
}

/**
 * The reply of `tracking/getTrackingInfo` for one air waybill: its scans, by
 * milestone rather than by time. An unknown air waybill is HTTP 200 with
 * `{"Message":"AWB does not exist."}`. Every scan must name the air waybill asked.
 */
export function parseAmerijet(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAmerijetNumber(raw);
  if (isRecord(payload) && Object.hasOwn(payload, 'Message')) {
    if (UNKNOWN.test(cleanScalar(payload.Message, 200))) throw new NotFoundError(PROVIDER);
    // The service's own failure message, such as "An error has occurred.".
    throw new IndeterminateError(PROVIDER, 'Amerijet did not complete the lookup');
  }
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Amerijet returned an invalid reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Amerijet returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of payload) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Amerijet returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock, then by milestone.
  const events = scans.sort((left, right) => {
    const [a, b] = [left.event.local_time as string, right.event.local_time as string];
    return a === b ? right.rank - left.rank : a < b ? 1 : -1;
  }).map((scan) => scan.event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
