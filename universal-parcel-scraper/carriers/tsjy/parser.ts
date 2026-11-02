import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeSeventeenFeiaNumber } from '../17feia/parser.js';
import { ESTIMATE, isTsjyDelay, tsjyStage } from './status.js';

export const PROVIDER = 'TSJY';
// A long history is a few kilobytes.
export const TSJY_MAX_BYTES = 256 * 1024;
// TSJY, nine digits and the origin's country.
const NUMBER = /^TSJY\d{9}CN$/;
// TSJY's warehouse is in Kunshan; its own rows are read on its clock.
const HOME_ZONE = 'Asia/Shanghai';
// No order predates the site; an earlier stamp is a placeholder.
const EARLIEST = Date.UTC(2015, 0, 1);
const MAX_ORDERS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
/**
 * 17FEIA's rows from its warehouse in China up to the export declaration.
 * 17FEIA writes them on Beijing time, so TSJY's reading of them is their
 * instant.
 */
const SEVENTEENFEIA_WAREHOUSE_ROWS: ReadonlySet<string> = new Set([
  'item information received.',
  'the package is on the way to the facility.',
  'warehouse receipt.',
  'the order has information pending customer confirmation.',
  'order confirmed.',
  'order dispatched from warehouse.',
  'export declaration in progress.',
]);

/**
 * The lines TSJY hands orders to, by the catalog id that tracks them and the
 * check that the line's number is one of its own. A channel number no line
 * claims goes to the one carrier whose high-confidence rule claims it, if any.
 */
export const TSJY_LINES: readonly { carrier: string; accepts: (number: string) => boolean }[] = [
  { carrier: '17feia', accepts: (number) => {
    try {
      return normalizeSeventeenFeiaNumber(number) === number;
    } catch {
      return false;
    }
  } },
];

/** A TSJY order number; anything else is a number its tracker is not asked for. */
export function normalizeTsjyNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TSJY order numbers are TSJY, nine digits and CN');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `TSJY returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/**
 * A row's clock and instant. TSJY's server stamps its own steps with
 * milliseconds: those are instants. A partner's rows come in whole seconds,
 * its wall clocks read on Beijing time, which is right for 17FEIA's rows from
 * its warehouse in China. A partner's place that ends with its country, as
 * `Town (DE)`, is read on that country's clock when it has one zone, as 17FEIA
 * reads the same row. The others keep their wall clock.
 */
function clockOf(stamp: number, warehouse: boolean, location: string): { at: number; clock: { time: string } | { local_time: string } } {
  const home = DateTime.fromMillis(stamp, { zone: HOME_ZONE });
  if (stamp % 1000 !== 0 || warehouse) return { at: stamp, clock: { time: home.startOf('second').toISO({ suppressMilliseconds: true })! } };
  const local = home.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const country = /\(([A-Z]{2})\)$/.exec(location)?.[1];
  const zone = country ? countryTimeZone(country) : null;
  const placed = zone ? firstOccurrence(DateTime.fromISO(local, { zone })) : null;
  // A clock the zone skips is no reading of the place's clock.
  if (placed?.isValid && placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) {
    return { at: placed.toMillis(), clock: { time: placed.toISO({ suppressMilliseconds: true }) } };
  }
  return { at: stamp, clock: { local_time: local } };
}

function projectRow(row: unknown, readAt: number, seventeenFeia: boolean): { key: string; at: number; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TSJY returned an invalid scan');
  const stamp = row.date;
  if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp) || stamp < EARLIEST) {
    throw new SchemaError(PROVIDER, 'TSJY returned an invalid scan time');
  }
  const description = text(row, 'event');
  if (!description || ESTIMATE.test(description)) return null;
  const location = text(row, 'loc', 200);
  const { at, clock } = clockOf(stamp, seventeenFeia && SEVENTEENFEIA_WAREHOUSE_ROWS.has(normalizeStatusWording(description)), location);
  // A row dated after the read is not a scan yet, and the line's estimated departure never is.
  if (at > readAt) return null;
  const staged = tsjyStage(description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([stamp, description, location]), at, event };
}

/** The line's number, when a line in the table or one carrier's high-confidence rule claims it. */
export function tsjyHandoff(channelNumber: string, number: string): { delivery_carrier: string; delivery_tracking_number: string } | null {
  const reference = channelNumber.length <= 64 ? normalizeTrackingNumber(channelNumber) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return null;
  const line = TSJY_LINES.find((candidate) => candidate.accepts(reference));
  if (line) return { delivery_carrier: line.carrier, delivery_tracking_number: reference };
  const detected = detectCarrierMatch(reference);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'tsjy'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: reference } : null;
}

/**
 * The reply of `POST /oms/api/v1/public/track/query`. The search also finds an
 * order by its line's number, so an order counts only when its own number is
 * the one asked. The order's internal id and the rows' ids open its details
 * and are never read.
 */
export function parseTsjy(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeTsjyNumber(raw);
  if (!isRecord(payload) || typeof payload.errcode !== 'number') throw new SchemaError(PROVIDER, 'TSJY returned an invalid envelope');
  if (payload.errcode !== 0) throw new IndeterminateError(PROVIDER, 'TSJY did not complete the lookup');
  const orders = isRecord(payload.ret) ? payload.ret.list : undefined;
  if (!Array.isArray(orders) || orders.length > MAX_ORDERS) throw new SchemaError(PROVIDER, 'TSJY returned an invalid order list');
  // The tracking page shows "no tracking information found" for an empty list.
  if (!orders.length) throw new NotFoundError(PROVIDER);
  const own = orders.filter((order) => {
    if (!isRecord(order)) throw new SchemaError(PROVIDER, 'TSJY returned an invalid order');
    return normalizeTrackingNumber(text(order, 'no', 64)) === number;
  }) as Record<string, unknown>[];
  if (own.length !== 1) throw new IndeterminateError(PROVIDER, own.length ? 'TSJY answered with several orders' : 'TSJY answered with another order');
  const order = own[0]!;
  // Each order says whether its lookup succeeded; without that its rows may be missing the line's.
  if (order.success !== 1 && order.success !== true) throw new IndeterminateError(PROVIDER, 'TSJY did not complete the order’s lookup');
  const rows = order.trackList;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'TSJY returned an order without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TSJY returned an oversized history');
  const line = tsjyHandoff(text(order, 'channelNo', 64), number);

  const seen = new Set<string>();
  const scans: { at: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    const scan = projectRow(row, readAt, line?.delivery_carrier === '17feia');
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'TSJY has no scans for the order yet');
  // Newest first, as the tracking page sorts them.
  const events = scans.sort((a, b) => b.at - a.at).map((scan) => scan.event);
  // Oldest first: a delayed flight keeps the stage of the row before it.
  let previous: string | undefined;
  for (const event of [...events].reverse()) {
    if (!isTsjyDelay(event.description!)) previous = event.stage ?? previous;
    else if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage && !isTsjyDelay(event.description!));
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...line,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
