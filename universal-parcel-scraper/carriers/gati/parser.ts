import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gatiStage } from './status.js';

export const PROVIDER = 'AllcargoGATI';
// A long history is under ten kilobytes.
export const GATI_MAX_BYTES = 512 * 1024;
const ZONE = 'Asia/Kolkata';
const SCAN_CLOCK = 'dd-LLL-yyyy HH:mm';
const DELIVERY_CLOCK = 'dd-LLL-yyyy HH:mm:ss';
const DAY = 'dd-LLL-yyyy';
const NUMBER = /^\d{9}$/;
// The tracking service's answer for a docket it does not know.
const MISSING = 'check docket no';
// The weight the reply gives, as "12  (Kgs)".
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?)\s*\(\s*kgs?\s*\)$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A docket number: nine digits. Anything else is not a number Gati issues. */
export function normalizeGatiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Gati docket numbers are nine digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `AllcargoGATI returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A docket number the reply names, whole: a string, or a nonnegative integer. */
function docket(value: unknown): string {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return typeof value === 'string' && value.length <= 64 ? normalizeTrackingNumber(value) : '';
}

/** A wall clock in the reply's format, read back unchanged, or null. */
function wallClock(value: string, format: string): DateTime | null {
  if (!value) return null;
  const wall = firstOccurrence(DateTime.fromFormat(value, format, { zone: ZONE, locale: 'en-US' }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  return wall.isValid && wall.toFormat(format).toUpperCase() === value.toUpperCase() ? wall : null;
}

function instant(time: DateTime): string {
  return time.toUTC().toISO({ suppressMilliseconds: true })!;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = text(row, 'intransitStatus');
  if (!description) throw new SchemaError(PROVIDER, 'AllcargoGATI returned a scan without wording');
  // Every scan is at a branch or hub of Gati's network in India, which keeps UTC+5:30 all year.
  const wall = wallClock(`${text(row, 'intransitDate', 16)} ${text(row, 'intransitTime', 16)}`, SCAN_CLOCK);
  if (!wall) throw new SchemaError(PROVIDER, 'AllcargoGATI returned an invalid scan time');
  const time = instant(wall);
  const location = text(row, 'intransitLocation', 120);
  const code = cleanScalar(row.milestonecode, 16).toUpperCase();
  const staged = gatiStage(code, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, code, description, location]), event };
}

/** A calendar day the reply gives as "21-JUL-2021", as an ISO date, or null. */
function day(value: string): string | null {
  return wallClock(value, DAY)?.toISODate() ?? null;
}

/** The weight booked for the docket, in kilograms. */
function weight(value: string): number | null {
  const kilograms = Number(WEIGHT.exec(value)?.[1]);
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/**
 * The reply of `admin.allcargologistics.com/api/track-shipment` for one
 * docket: `details` holds one entry per docket asked, which names it. The
 * tracking service answers a docket it does not know with `Check Docket No`.
 * The consignor, consignee, receiver, remarks, references and proof of
 * delivery link are not read.
 */
export function parseGati(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGatiNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'AllcargoGATI returned an invalid envelope');
  if (payload.success !== true) {
    // The site checks the number before it asks the tracking service.
    if (payload.success === false && isRecord(payload.errors)) throw new InvalidInputError(PROVIDER, 'AllcargoGATI refused the docket number', { reason: 'wrong_number' });
    // The site relays a failure of the tracking service behind it, such as its timeout.
    if (payload.success === false && typeof payload.error === 'string') throw new IndeterminateError(PROVIDER, 'AllcargoGATI tracking service did not answer');
    throw new SchemaError(PROVIDER, 'AllcargoGATI returned an invalid envelope');
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.details)) throw new SchemaError(PROVIDER, 'AllcargoGATI returned a reply without dockets');
  if (text(data, 'result', 40).toLowerCase() !== 'successful') throw new IndeterminateError(PROVIDER, 'AllcargoGATI did not complete the lookup');
  if (data.details.length !== 1 || !isRecord(data.details[0])) throw new SchemaError(PROVIDER, 'AllcargoGATI returned an unexpected list of dockets');
  const detail = data.details[0];
  const asked = docket(detail.dktno);
  if (!asked) throw new SchemaError(PROVIDER, 'AllcargoGATI returned a docket without its number');
  if (asked !== number) throw new IndeterminateError(PROVIDER, 'AllcargoGATI answered for another docket');
  const result = text(detail, 'result', 40).toLowerCase();
  if (result === 'failed') {
    if (text(detail, 'errmsg', 120).toLowerCase() === MISSING) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'AllcargoGATI did not complete the lookup');
  }
  if (result !== 'successful') throw new SchemaError(PROVIDER, 'AllcargoGATI returned a docket without a result');
  if (docket(detail.docketNumber) !== number) throw new IndeterminateError(PROVIDER, 'AllcargoGATI answered for another docket');

  const rows = detail.TRANSIT_DTLS ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'AllcargoGATI returned a docket with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'AllcargoGATI returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'AllcargoGATI returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the reply lists them; an oldest-first reply is turned round.
  const newestFirst = events[0]!.time! < events.at(-1)!.time! ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  // The docket's own status, which the page shows over the scans.
  const summary: Stage | undefined = text(detail, 'docketStatus', 80).toLowerCase() === 'delivered' ? 'delivered' : undefined;
  const stage = summary ?? scanned?.stage as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered'
    ? wallClock(text(detail, 'DeliveryDt', 32), DELIVERY_CLOCK) ?? newestFirst.find((event) => event.stage === 'delivered')
    : undefined;
  // A revised date replaces the one promised at booking.
  const expected = stage === 'delivered' ? null : day(text(detail, 'revisedAssuredDeliveryDate', 32)) ?? day(text(detail, 'assuredDlyDate', 32));
  const kilograms = weight(text(detail, 'actualWeight', 40));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: expected,
    ...(delivered ? { delivered_at: delivered instanceof DateTime ? instant(delivered) : delivered.time! } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    timezone: ZONE,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
