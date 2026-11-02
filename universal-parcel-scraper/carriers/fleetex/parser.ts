import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fleetexStage } from './status.js';

export const PROVIDER = 'FleetExpress';
// A delivered parcel's reply is under a kilobyte.
export const FLEETEX_MAX_BYTES = 256 * 1024;
// SR and twelve digits for a parcel, DS and twelve digits for a package, as FleetExpress's API documentation gives them.
const NUMBER = /^(?:SR|DS)\d{12}$/;
// An instant as the feed writes it, to the second and with an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
// The feed's notice for a number it holds no parcel under.
const NO_MATCH = /^tracking number not found\.?$/i;
const MAX_ROWS = 200;

/** A number for FleetExpress's tracker, in capitals; anything else is not one FleetExpress issues. */
export function normalizeFleetexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FleetExpress numbers are SR or DS and twelve digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`FleetExpress returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `time`, an instant with an offset. The offset is the one of the
 * zone set on the shipper's account rather than the scan's place: a Quebec
 * scan has come with Sydney's. The instant is kept, in UTC.
 */
function scanTime(value: string): { time: string; at: number } {
  const match = CLOCK.exec(value);
  const parsed = match ? DateTime.fromISO(value, { setZone: true }) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== match[1]) invalid('FleetExpress returned an invalid scan time');
  const utc = parsed.toUTC().startOf('second');
  return { time: utc.toISO({ suppressMilliseconds: true }), at: utc.toMillis() };
}

interface Scan { at: number; index: number; key: string; event: CarrierEvent }

/** A scan, or null when it has no message. Its place is a depot's name when the feed gives one. */
function projectRow(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) invalid('FleetExpress returned an invalid scan');
  const { time, at } = scanTime(text(row, 'time', 40));
  const description = text(row, 'content', 300);
  if (!description) return null;
  const location = text(row, 'location', 120);
  const staged = fleetexStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, index, key: JSON.stringify([at, description.toLowerCase(), location]), event };
}

/**
 * The reply of the feed FleetExpress's API publishes for 17TRACK, for one
 * number: the parcel's number, its scans oldest first, each with an instant, a
 * message and sometimes a place, and an overall status in 17TRACK's
 * vocabulary, which is not read. A number it holds no parcel under is HTTP 200
 * with the notice `Tracking number not found`. The reply must name the number
 * asked. The shipper's name and own reference and the parcel's countries are
 * never read.
 */
export function parseFleetex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFleetexNumber(raw);
  if (!isRecord(payload)) invalid('FleetExpress returned an invalid reply');
  if (typeof payload.number !== 'string') invalid('FleetExpress returned a reply without its number');
  if (normalizeTrackingNumber(clean(payload.number, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'FleetExpress answered for another parcel');
  }
  if (payload.error !== null && payload.error !== undefined) {
    if (typeof payload.error === 'string' && NO_MATCH.test(clean(payload.error, 200))) {
      throw new NotFoundError(PROVIDER, 'FleetExpress has no parcel under this number');
    }
    invalid('FleetExpress answered with an unknown notice');
  }
  const rows = payload.events;
  if (!Array.isArray(rows)) invalid('FleetExpress returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) invalid('FleetExpress returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row: unknown, index) => {
    const scan = projectRow(row, index);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the feed lists the oldest first, so of two scans at one instant the later row is newer.
  const events = scans.sort((a, b) => b.at - a.at || b.index - a.index).map((scan) => scan.event);

  const newest = events[0]!;
  // The newest staged scan settles the status.
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events,
  };
}
