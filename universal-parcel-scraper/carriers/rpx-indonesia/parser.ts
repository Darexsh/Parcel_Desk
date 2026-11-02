import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, type CarrierError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { rpxStage } from './status.js';

export const PROVIDER = 'RPX';
// A long history is a few kilobytes.
export const RPX_MAX_BYTES = 256 * 1024;
// RPX's AWBs: twelve digits, the length its own tracking API documents.
const NUMBER = /^\d{12}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Aug 11, 2026" and "08:30 PM".
const DATE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const CLOCK = /^(\d{1,2}):(\d{2}) ([AP]M)$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The parcel's weight at the end of a scan's note: "By_CONS … - |7.0000 Kg".
const WEIGHT = /\|\s*(\d{1,5}(?:\.\d{1,4})?)\s*kg\s*$/i;
// A scan without a station names it "NA".
const NO_PLACE = /^(?:NA|N\/A|-+)$/i;
// Stations are named after their place: "RPX Cikarang".
const BRAND = /^RPX\s+(?=\S)/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The service's answer for a number it does not know.
const UNKNOWN = /^No data found\b/i;

/** An RPX AWB; anything else is not one RPX issues. */
export function normalizeRpxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'RPX AWBs are twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `RPX returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wording without phone numbers. */
export function rpxWording(description: string): string {
  return clean(description.replace(PHONE, '').replace(/\s+([,.;:])/g, '$1')).replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's clock: `TRACKING_DATE` and `TRACKING_TIME` are the station's wall
 * clock to the minute, with no zone, and Indonesia spans three zones, so the
 * clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'TRACKING_DATE', 20));
  const time = CLOCK.exec(text(row, 'TRACKING_TIME', 12));
  const month = date ? MONTHS.indexOf(date[1]!) + 1 : 0;
  const hour = time ? Number(time[1]) : 0;
  if (!date || !time || month === 0 || hour < 1 || hour > 12) throw new SchemaError(PROVIDER, 'RPX returned an invalid scan time');
  const parsed = DateTime.fromObject({ year: Number(date[3]), month, day: Number(date[2]),
    hour: (hour % 12) + (time[3]!.toUpperCase() === 'PM' ? 12 : 0), minute: Number(time[2]) }, { zone: 'UTC' });
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'RPX returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The station a scan names, by its place. */
function station(row: Record<string, unknown>): string {
  const value = text(row, 'LOCATION', 120);
  return NO_PLACE.test(value) ? '' : value.replace(BRAND, '');
}

/** The weight a scan's note ends with, in kilograms. */
function weightOf(row: Record<string, unknown>): number | null {
  const match = WEIGHT.exec(text(row, 'TRACKING_COMMENT', 500));
  const kg = match ? Number(match[1]) : 0;
  return Number.isFinite(kg) && kg > 0 ? kg : null;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent; weight: number | null } {
  const code = cleanScalar(row.TRACKING_ID, 16).toUpperCase();
  const description = rpxWording(text(row, 'TRACKING_DESC'));
  if (!description) throw new SchemaError(PROVIDER, 'RPX returned a scan without wording');
  const local = scanClock(row);
  const location = station(row);
  const staged = rpxStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event, weight: weightOf(row) };
}

/** The delivery estimate, a calendar day; the reply leaves it empty when it has none. */
function estimate(detail: Record<string, unknown>): string | null {
  const value = text(detail, 'ETA', 32);
  return DAY.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/**
 * The error a refused lookup stands for. The service answers HTTP 400 with
 * RPX's own error as a JSON string in `message`; "No data found" is its
 * answer for a number it does not know.
 */
export function rpxRefusal(payload: unknown): CarrierError {
  if (!isRecord(payload) || typeof payload.message !== 'string') return new SchemaError(PROVIDER, 'RPX returned an invalid refusal');
  let inner: unknown;
  try {
    inner = JSON.parse(payload.message);
  } catch (cause) {
    return new SchemaError(PROVIDER, 'RPX returned an invalid refusal', { cause });
  }
  const error = isRecord(inner) && isRecord(inner.RPX) && isRecord(inner.RPX.ERROR) ? inner.RPX.ERROR : null;
  const message = error && typeof error.MSG === 'string' ? clean(error.MSG, 200) : '';
  if (UNKNOWN.test(message)) return new NotFoundError(PROVIDER);
  if (message) return new IndeterminateError(PROVIDER, 'RPX refused the lookup');
  return new SchemaError(PROVIDER, 'RPX returned an invalid refusal');
}

/**
 * The reply of the app's `rpx/tracking/{awb}` lookup: the scans newest first
 * and the delivery details. It does not name the AWB; the request names one.
 * The recipient, who signed, where the parcel was left, the delivery photos and
 * the delivery coordinates are not kept.
 */
export function parseRpx(payload: unknown, raw: string): CarrierResult {
  normalizeRpxNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'RPX returned an invalid envelope');
  if (!Object.hasOwn(payload, 'data_tracking')) {
    // The service's own failure, as `{"statusCode":500,"message":"Internal server error"}`.
    if (typeof payload.statusCode === 'number' && payload.statusCode >= 500) throw new IndeterminateError(PROVIDER, 'RPX did not complete the lookup');
    throw new SchemaError(PROVIDER, 'RPX returned an invalid envelope');
  }
  const rows = payload.data_tracking ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'RPX returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'RPX returned an oversized history');
  const detail = payload.detail_received ?? {};
  if (!isRecord(detail)) throw new SchemaError(PROVIDER, 'RPX returned invalid delivery details');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; weight: number | null }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'RPX returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the app lists them; an oldest-first reply is turned round.
  const local = (index: number) => scans.at(index)!.event.local_time as string;
  const newestFirst = local(0) < local(-1) ? scans.reverse() : scans;
  const events = newestFirst.map((scan) => scan.event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const weight = newestFirst.find((scan) => scan.weight !== null)?.weight;
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(detail);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
