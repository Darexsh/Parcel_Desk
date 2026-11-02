import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { precisionStage } from './status.js';

export const PROVIDER = 'Precision Deliveries';
// Every scan repeats the parcel's addresses, and a delivered one can carry its
// proof of delivery as images inside the reply.
export const PRECISION_MAX_BYTES = 8 * 1024 * 1024;
// The parcel ids its tracking links carry: three letters, a digit, then letters and digits.
const NUMBER = /^[A-Z]{3}\d[0-9A-Z]{9,20}$/;
const STAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?)?$/;
// Canada's offsets, from Pacific standard time to Newfoundland summer time.
const MIN_OFFSET = -8 * 60;
const MAX_OFFSET = -150;
const MAX_ITEMS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Precision parcel id in capitals; anything else is not one it issues. */
export function normalizePrecisionNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Precision Deliveries parcel ids are three letters, a digit and nine or more letters or digits');
  return number;
}

/** Whether a reply's identifier is the whole number asked. */
function sameNumber(value: unknown, number: string): boolean {
  return typeof value === 'string' && value.length <= 64 && value.trim().toUpperCase() === number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Precision Deliveries returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A `yyyy-MM-dd HH:mm:ss` clock as an offset-less ISO wall clock, or null when the reply leaves it empty. */
function wallClock(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value) return null;
  const match = STAMP.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Precision Deliveries returned an invalid scan time');
  }
  return local;
}

/**
 * A scan's clock. `scandatetime` is UTC and `scandatetimelocal` the wall clock
 * the page shows: their difference is the scan's offset, and an instant keeps
 * it. Where the two agree, as on the manifest row, the reply does not say which
 * one it gives, so the page's wall clock stays local.
 */
function scanClock(row: Record<string, unknown>): { clock: { time: string } | { local_time: string }; order: string } {
  const utc = wallClock(row, 'scandatetime');
  const local = wallClock(row, 'scandatetimelocal') ?? utc;
  if (!local) throw new SchemaError(PROVIDER, 'Precision Deliveries returned a scan without a time');
  if (utc && utc !== local) {
    const instant = DateTime.fromISO(utc, { zone: 'UTC' });
    const offset = DateTime.fromISO(local, { zone: 'UTC' }).diff(instant, 'minutes').minutes;
    if (Number.isInteger(offset) && offset % 30 === 0 && offset >= MIN_OFFSET && offset <= MAX_OFFSET) {
      return { clock: { time: instant.setZone(FixedOffsetZone.instance(offset)).toISO({ suppressMilliseconds: true })! }, order: utc };
    }
  }
  return { clock: { local_time: local }, order: utc ?? local };
}

function projectRow(row: Record<string, unknown>): { key: string; order: string; event: CarrierEvent } {
  if (row.status !== null && row.status !== undefined && typeof row.status !== 'string' && typeof row.status !== 'number') {
    throw new SchemaError(PROVIDER, 'Precision Deliveries returned an invalid scan code');
  }
  const code = cleanScalar(row.status, 40);
  // The English wording the page shows, else the code's own description; the page names a scan without either "Unknown Status".
  const description = text(row, 'publicstatus') || text(row, 'statusdesc') || code;
  if (!description) throw new SchemaError(PROVIDER, 'Precision Deliveries returned a scan without wording');
  const { clock, order } = scanClock(row);
  const staged = precisionStage(code, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock, code, description]), order, event };
}

/** The estimate's calendar day; the page shows it as the day the parcel arrives. */
function estimate(item: Record<string, unknown>): string | null {
  const match = DAY.exec(text(item, 'edd', 40));
  if (!match || match[1]! < '2000-01-01') return null;
  return DateTime.fromISO(match[1]!, { zone: 'UTC' }).isValid ? match[1]! : null;
}

/**
 * The 404 the parcel lookup answers for a number Precision does not hold:
 * `{"error":"No item was found","itemId":…}`, echoing the number. Anything
 * else under a 404 is a moved route.
 */
export function precisionMissing(payload: unknown, raw: string): never {
  const number = normalizePrecisionNumber(raw);
  if (isRecord(payload) && typeof payload.error === 'string' && /^no item (?:was )?found\.?$/i.test(payload.error.trim())) {
    if (sameNumber(payload.itemId, number)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Precision Deliveries answered for another number');
  }
  throw new TransportError(PROVIDER, 'Precision Deliveries tracking lookup is unavailable', { status: 404 });
}

/**
 * The reply of `/api/shipment-itemId/{number}`: the parcel with its scans,
 * oldest first. The page also reads a list of parcels; the one whose `itemid`
 * is the number asked is the answer. Recipient, shipper, driver, route,
 * coordinates and proof of delivery are not kept.
 */
export function parsePrecision(payload: unknown, raw: string): CarrierResult {
  const number = normalizePrecisionNumber(raw);
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'Precision Deliveries returned too many parcels');
  if (!items.length) throw new IndeterminateError(PROVIDER, 'Precision Deliveries returned no parcel');
  for (const item of items) {
    if (!isRecord(item) || typeof item.itemid !== 'string') throw new SchemaError(PROVIDER, 'Precision Deliveries returned a parcel without its id');
  }
  const item = (items as Record<string, unknown>[]).find((candidate) => sameNumber(candidate.itemid, number));
  if (!item) throw new IndeterminateError(PROVIDER, 'Precision Deliveries answered for another parcel');
  const rows = item.scanevents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Precision Deliveries returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Precision Deliveries returned an oversized history');

  const seen = new Set<string>();
  const scans: { order: string; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Precision Deliveries returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The page reads the scans oldest first, its last one being the current status; a newest-first reply stays as it is.
  const events = (scans[0]!.order > scans.at(-1)!.order ? scans : scans.reverse()).map((scan) => scan.event);

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(item),
    ...(stage === 'delivered' && decider!.time ? { delivered_at: decider!.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
