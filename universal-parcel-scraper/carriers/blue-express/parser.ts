import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { blueExpressReturnStarts, blueExpressStage } from './status.js';

export const PROVIDER = 'Blue Express';
// A history of a hundred and seventy scans is under fifty kilobytes.
export const BLUE_EXPRESS_MAX_BYTES = 512 * 1024;
// A service order (orden de servicio) number.
const NUMBER = /^\d{10}$/;
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
// The day the lookup sends for a scan it lost the date of.
const LOST_DAY = 'NaN-NaN-NaN';
// The sender's announcement, whose place the page leaves out.
const UNPLACED = new Set(['FI', 'GE']);
const MAX_DAYS = 1000;
const MAX_SCANS = 1000;
const MAX_EVENTS = 100;

/** A Blue Express service order number; anything else is not one it issues. */
export function normalizeBlueExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Blue Express service order numbers are ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Blue Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: its day, `DD-MM-YYYY`, and its time to the second. The reply
 * names no zone, and the network spans Magallanes, which keeps one offset all
 * year while the rest of mainland Chile changes its clocks, so the clock stays
 * local. A scan the lookup lost the date of keeps no clock.
 */
function scanClock(day: string, time: string): string | undefined {
  if (day === LOST_DAY) return undefined;
  const parts = DAY.exec(day);
  const local = parts ? `${parts[3]}-${parts[2]}-${parts[1]}T${time}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parts || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Blue Express returned an invalid scan time');
  }
  return local;
}

interface Scan {
  key: string;
  event: CarrierEvent;
  returning: boolean;
}

/**
 * One scan as the page lists it, or null for one without a title, which the
 * page leaves out: its title, the town or point the page names, and its code.
 */
function readScan(day: string, row: unknown): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Blue Express returned an invalid scan');
  const code = text(row, 'eventCode', 16).toUpperCase();
  if (!code) throw new SchemaError(PROVIDER, 'Blue Express returned a scan without its code');
  const title = text(row, 'title', 300);
  const time = text(row, 'time', 16);
  const location = UNPLACED.has(code) ? '' : text(row, 'displayLocationName', 120);
  if (!title) return null;
  const local = scanClock(day, time);
  const staged = blueExpressStage(code, title);
  const event: CarrierEvent = {
    ...(local ? { local_time: local } : {}),
    ...(location ? { location } : {}),
    description: title,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, title, location]), event, returning: blueExpressReturnStarts(code, title) };
}

/**
 * The reply of the tracking page's `/api/tracking/microestado` for one
 * service order: the scans by day, newest first. The lookup answers a number
 * it does not know with `{"status":"Error",…,"data":null}`, which the page
 * reports as not found. A history must name the number asked.
 */
export function parseBlueExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBlueExpressNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Blue Express returned an invalid reply');
  if (payload.status === 'Error' && payload.data === null) throw new NotFoundError(PROVIDER);
  const trace = isRecord(payload.data) ? payload.data.traceMicrostates : undefined;
  if (payload.status !== 'ok' || !isRecord(trace)) throw new SchemaError(PROVIDER, 'Blue Express returned an invalid envelope');
  if (typeof trace.orderId !== 'string') throw new SchemaError(PROVIDER, 'Blue Express returned a history without its number');
  if (trace.orderId.trim() !== number) throw new IndeterminateError(PROVIDER, 'Blue Express answered for another shipment');
  const days = trace.microstates ?? [];
  if (!Array.isArray(days) || days.length > MAX_DAYS) throw new SchemaError(PROVIDER, 'Blue Express returned an invalid history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  let count = 0;
  for (const group of days) {
    if (!isRecord(group) || typeof group.rawDate !== 'string' || !Array.isArray(group.events)) {
      throw new SchemaError(PROVIDER, 'Blue Express returned an invalid day');
    }
    count += group.events.length;
    if (count > MAX_SCANS) throw new SchemaError(PROVIDER, 'Blue Express returned an oversized history');
    for (const row of group.events) {
      const scan = readScan(group.rawDate.trim(), row);
      if (!scan || seen.has(scan.key)) continue;
      seen.add(scan.key);
      scans.push(scan);
    }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const dated = scans.filter((scan) => scan.event.local_time);
  if (dated.length > 1 && (dated[0]!.event.local_time as string) < (dated.at(-1)!.event.local_time as string)) scans.reverse();

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // A return to the sender holds until the parcel reaches the sender or,
  // should the return be called off, the recipient: the rounds in between
  // take it back.
  const returning = scans.findIndex((scan) => scan.returning);
  const ended = events.findIndex((event) => event.stage === 'delivered' || event.stage === 'returned');
  const homeward = returning >= 0 && (ended < 0 || returning < ended);
  const stage = (homeward ? 'exception' : staged?.stage) as Stage | undefined;
  const source = homeward && staged?.stage !== 'exception' ? 'carrier_map' : staged?.stage_source;
  const clocked = events.find((event) => event.local_time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    ...(clocked ? { last_update_local: clocked.local_time } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
