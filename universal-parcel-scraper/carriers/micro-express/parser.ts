import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { microExpressStage } from './status.js';

export const PROVIDER = 'Micro Express';
export const CARRIER = 'micro-express';
// A five-scan history is under two kilobytes.
export const MICRO_EXPRESS_MAX_BYTES = 256 * 1024;
// ME, the order's creation time in milliseconds and three letters or digits.
const NUMBER = /^ME\d{13}[A-Z0-9]{3}$/;
// The zone the reply names for its clocks, and the page with them.
const ZONE = 'Australia/Melbourne';
// Scan clocks from 2000 to 2100, in milliseconds.
const EARLIEST = 946_684_800_000;
const LATEST = 4_102_444_800_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An ME tracking number, in upper case; anything else is not one Micro Express issues. */
export function normalizeMicroExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Micro Express numbers are ME, thirteen digits and three letters or digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Micro Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The courier app words a delivery to a collection shop with the shop's name,
// address and phone in brackets: "Delivered by STORE(name. address:… phone:…)".
const SHOP_DETAILS = /\s*\((?=[^)]*\b(?:address|phone)\s*:)[\s\S]*$/i;
// A run of eight or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;

/** A scan's wording, without a collection shop's details or a phone number. */
export function microExpressWording(description: string): string {
  return clean(description.replace(SHOP_DETAILS, '').replace(PHONE, '')).replace(/[\s,;:\-–]+$/, '');
}

// A town with digits in it is an address, not a depot's suburb.
const NOT_A_PLACE = /\d/;

interface Scan {
  millis: number;
  index: number;
  key: string;
  event: CarrierEvent;
}

/**
 * One row of `tracking_log`. `timestamp` is the scan's instant in
 * milliseconds; `local_time` and `time` repeat it as the wall clock of
 * `time_zone`, which the page shows beside them. The instant is kept, in the
 * zone the row names.
 */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Micro Express returned an invalid scan');
  const millis = row.timestamp;
  if (typeof millis !== 'number' || !Number.isSafeInteger(millis) || millis < EARLIEST || millis >= LATEST) {
    throw new SchemaError(PROVIDER, 'Micro Express returned an invalid scan time');
  }
  const named = text(row, 'time_zone', 64);
  const time = DateTime.fromMillis(millis, { zone: IANAZone.isValidZone(named) ? named : ZONE }).toISO({ suppressMilliseconds: true })!;
  const code = text(row, 'event_code', 32).toUpperCase();
  const description = microExpressWording(text(row, 'description')) || code;
  if (!description) throw new SchemaError(PROVIDER, 'Micro Express returned a scan without wording');
  const place = text(row, 'location', 80);
  const location = NOT_A_PLACE.test(place) ? '' : place;
  const staged = microExpressStage(code, description);
  return {
    millis, index,
    key: JSON.stringify([millis, code, description, location]),
    event: {
      time,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/**
 * The reply of the tracking page's `/partner/tracking-info` for one number.
 * `code` 200 with an empty `tracking_log` is a number Micro Express does not
 * hold, which the page reports as having no logistics information; another
 * `code` is a refused lookup. The reply repeats the number as it was sent in
 * `tracking_number`, which must be the one asked.
 *
 * `tracking_status` is not read: the page derives its status from the newest
 * scan's code.
 */
export function parseMicroExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMicroExpressNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Micro Express returned an invalid envelope');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'Micro Express did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || typeof data.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'Micro Express returned a reply without its number');
  if (data.tracking_number.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Micro Express answered for another shipment');
  const rows = data.tracking_log ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Micro Express returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Micro Express returned an oversized history');
  if (!rows.length) throw new NotFoundError(PROVIDER);

  // Newest first by instant; a scan entered later can sit out of order in the reply.
  const scans = rows.map(scanOf).sort((a, b) => b.millis - a.millis || a.index - b.index);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const scan of scans) {
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
