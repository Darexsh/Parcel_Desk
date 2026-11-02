import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeDpdIeNumber } from '../dpd-ie/parser.js';
import { drop2shopStage } from './status.js';

export const PROVIDER = 'Drop2Shop';
export const DROP2SHOP_ZONE = 'Europe/Dublin';
// A history is a few kilobytes.
export const DROP2SHOP_MAX_BYTES = 256 * 1024;
// GLB and thirteen digits, the numbers COLL-8 gives its parcels.
const NUMBER = /^GLB\d{13}$/;
// One package of a shipment: the shipment's number and the package's three digits.
const PACKAGE = /^GLB\d{16}$/;
// A wall clock to the second; archived replies carried fractions of a second.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const OFFSET_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/i;
// COLL-8's own records: the parcel's creation and its customs entries. Their
// clock is UTC: a creation runs an hour behind the sender-data scan it comes
// with during Irish summer time and agrees with it in winter, and in archived
// replies both kinds kept the milliseconds the partner's scans lack.
const COLL8_RECORD = /^(?:DAT$|CUSM)/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Drop2Shop number in capitals, as the tracker shows it; anything else is not one COLL-8 issues. */
export function normalizeDrop2ShopNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Drop2Shop numbers are GLB and thirteen digits');
  return number;
}

/** A text field; anything but a string or a number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new SchemaError(PROVIDER, `Drop2Shop returned an invalid ${key}`);
  }
  return clean(String(value), maxLength);
}

/**
 * A scan's instant. COLL-8's own records keep its server's UTC clock; the
 * delivery partner's scans keep the partner's Irish wall clock. A clock that
 * names its offset keeps it.
 */
function instantOf(stamp: string, utc: boolean): { time: string; at: number } {
  if (OFFSET_CLOCK.test(stamp)) {
    const parsed = explicitOffsetTime(stamp);
    if (parsed) return { time: parsed.iso, at: parsed.timestamp };
  }
  const wall = WALL_CLOCK.exec(stamp)?.[1];
  // UTC checks the calendar digits only: Luxon rolls 24:00 over, and a clock must read back unchanged.
  const calendar = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !calendar?.isValid || calendar.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Drop2Shop returned an invalid scan time');
  }
  const parsed = utc ? calendar : firstOccurrence(DateTime.fromISO(wall, { zone: DROP2SHOP_ZONE }));
  return { time: parsed.toISO({ suppressMilliseconds: true })!, at: parsed.toMillis() };
}

interface Scan { at: number; event: CarrierEvent; partner: string; reference: string }

function projectRow(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Drop2Shop returned an invalid scan');
  const parcel = text(row, 'packageTrackingNumber', 64).toUpperCase();
  if (!parcel) throw new SchemaError(PROVIDER, 'Drop2Shop returned a scan without its parcel');
  if (parcel !== number && !(PACKAGE.test(parcel) && parcel.startsWith(number))) throw new IndeterminateError(PROVIDER, 'Drop2Shop answered for another shipment');
  const code = text(row, 'eventCode', 32).toUpperCase();
  const description = text(row, 'description', 300);
  if (!description) throw new SchemaError(PROVIDER, 'Drop2Shop returned a scan without wording');
  const { time, at } = instantOf(text(row, 'eventDateTime', 40), COLL8_RECORD.test(code));
  const staged = drop2shopStage(code, description);
  const event: CarrierEvent = {
    time,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, event, partner: text(row, 'odaCarrier', 40), reference: text(row, 'odaTrackingNumber', 64) };
}

/**
 * The hand-off the tracker shows beside the newest scan: COLL-8's carrier list
 * sends a DPD parcel's recipient to DPD Ireland's tracker with the partner's
 * own consignment number. Only a whole number DPD Ireland's rule accepts is kept.
 */
function handoff(newest: Scan): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (newest.partner.toUpperCase() !== 'DPD') return {};
  try {
    return { delivery_carrier: 'dpd-ie', delivery_tracking_number: normalizeDpdIeNumber(newest.reference) };
  } catch (error) {
    if (error instanceof InvalidInputError) return {};
    throw error;
  }
}

/**
 * The reply of the tracking page's `/api-ship/tracking/{number}/scan`: every
 * scan of each package of the shipment, in no particular order. A number the
 * tracker does not know has no scans, which the page reports as not found.
 * Every scan must belong to a package of the number asked.
 */
export function parseDrop2Shop(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDrop2ShopNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Drop2Shop returned an invalid envelope');
  const rows = payload.data;
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Drop2Shop returned an oversized history');

  // Each package repeats the shipment's scans; one scan is kept once.
  const scans = new Map<string, Scan>();
  rows.forEach((row) => {
    const scan = projectRow(row, number);
    const key = JSON.stringify([scan.at, scan.event.provider_code, scan.event.description]);
    if (!scans.has(key)) scans.set(key, scan);
  });
  // Newest first, as the page lists them; scans at the same instant keep the reply's order.
  const ordered = [...scans.values()];
  if (listsNewestFirst(ordered.map(({ event }) => event)) === false) ordered.reverse();
  ordered.sort((left, right) => right.at - left.at);
  const events = ordered.map((scan) => scan.event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...handoff(ordered[0]!),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
