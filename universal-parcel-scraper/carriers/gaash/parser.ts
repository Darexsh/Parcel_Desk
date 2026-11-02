import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gaashStage } from './status.js';

export const PROVIDER = 'GAASH';
// A long history is a few kilobytes.
export const GAASH_MAX_BYTES = 256 * 1024;
// The layouts GAASH's tracker is known to answer: GWD and nine digits,
// GAIH and eight, PH and ten.
const NUMBER = /^(?:GWD\d{9}|GAIH\d{8}|PH\d{10})$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const OFFSET = /^GMT([+-](?:0\d|1[0-4]):[0-5]\d)$/;
const CODE = /^\d{1,6}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for GAASH's tracker, in upper case; anything else is not one it issues. */
export function normalizeGaashNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GAASH numbers are GWD and nine digits, GAIH and eight, or PH and ten');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GAASH returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock. `StatusTime` is the wall clock in Israel, and
 * `TimeZoneOffset` the offset Israel had then: `GMT+02:00` in winter and
 * `GMT+03:00` in summer. A scan without an offset keeps its wall clock.
 */
function scanClock(row: Record<string, unknown>): { time?: string; local_time?: string } {
  const wall = WALL_CLOCK.exec(text(row, 'StatusTime', 40))?.[1];
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'GAASH returned an invalid scan time');
  }
  const label = text(row, 'TimeZoneOffset', 16);
  if (!label) return { local_time: wall };
  const offset = OFFSET.exec(label)?.[1];
  const instant = offset ? explicitOffsetTime(`${wall}${offset}`) : null;
  if (!instant) throw new SchemaError(PROVIDER, 'GAASH returned an invalid scan offset');
  return { time: instant.iso };
}

function scan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GAASH returned an invalid scan');
  const code = cleanScalar(row.StatusCode, 16);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'GAASH returned an invalid status code');
  const description = text(row, 'StatusDescription');
  if (!description) throw new SchemaError(PROVIDER, 'GAASH returned a scan without wording');
  const clock = scanClock(row);
  const staged = gaashStage(code, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.time ?? clock.local_time, code, description.toLowerCase()]), event };
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** The pickup point the page shows: its name, then its address, which the reply puts after the first comma. */
function pickupPoint(details: string): string | null {
  const [name = '', ...address] = details.replace(PHONE, '').split(',').map((part) => clean(part, 200)).filter(Boolean);
  if (!name) return null;
  return address.length ? `${name}\n${address.join(', ')}` : name;
}

// The page's `DistributionStatus.StatusType` for a parcel GAASH delivers itself that ended its journey.
const DISTRIBUTION: ReadonlyMap<number, Stage> = new Map([
  [2, 'delivered'],
  [3, 'exception'], // Damaged.
  [4, 'exception'], // Lost.
  [6, 'returned'],
]);

/**
 * The status reply's word for a parcel whose journey ended or stopped, which
 * the page shows over the scans: a delivery, a return, a damaged or lost
 * parcel, or a customs clearance that cannot go on (`FinalStatuses`).
 */
function summaryStage(status: Record<string, unknown>): Stage | undefined {
  const distribution = status.DistributionStatus;
  if (status.IsHandlingDistribution === true && isRecord(distribution) && typeof distribution.StatusType === 'number') {
    const stage = DISTRIBUTION.get(distribution.StatusType);
    if (stage) return stage;
  }
  if (Array.isArray(status.FinalStatuses) && status.FinalStatuses.length) return 'exception';
  return undefined;
}

/**
 * The tracking page's two replies for one number: `parcel-tracking-data`,
 * with the scans, and `parcel-status-data`, with the parcel's customs and
 * delivery status. For a number GAASH does not know, the first has no parcel
 * and the second is `{"code":"no_data"}`, which the page reports as not found.
 * The scans must be the number asked's, as the parcel's `TrackingNumber` or its
 * `HAWB`, and the status must be the same parcel's.
 */
export function parseGaash(tracking: unknown, status: unknown, raw: string): CarrierResult {
  const number = normalizeGaashNumber(raw);
  if (!isRecord(tracking) || !isRecord(status)) throw new SchemaError(PROVIDER, 'GAASH returned an invalid envelope');
  const own = text(tracking, 'TrackingNumber', 64).toUpperCase();
  const hawb = text(tracking, 'HAWB', 64).toUpperCase();
  const rows: unknown = tracking.Statuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GAASH returned a parcel with invalid scans');
  if (status.code === 'no_data') {
    if (own || hawb || rows.length) throw new IndeterminateError(PROVIDER, 'GAASH gave scans for a parcel it reports missing');
    throw new NotFoundError(PROVIDER);
  }
  if (!own && !hawb) throw new IndeterminateError(PROVIDER, 'GAASH gave a status for a parcel without scans');
  if (own !== number && hawb !== number) throw new IndeterminateError(PROVIDER, 'GAASH answered for another shipment');
  const statusHawb = text(status, 'Hawb', 64).toUpperCase();
  if (!statusHawb) throw new SchemaError(PROVIDER, 'GAASH returned a status without its parcel');
  if (statusHawb !== number && statusHawb !== hawb) throw new IndeterminateError(PROVIDER, 'GAASH answered for another shipment');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GAASH returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // The reply lists the scans oldest first; the result has them newest first.
  for (const row of [...(rows as unknown[])].reverse()) {
    // The page leaves out a scan without a time.
    if (isRecord(row) && !text(row, 'StatusTime', 40)) continue;
    const { key, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = summaryStage(status);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const pickup = pickupPoint(text(tracking, 'PudoDetails', 400));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(typeof delivered === 'string' ? { delivered_at: delivered } : {}),
    ...(pickup ? { pickup_point: pickup } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
