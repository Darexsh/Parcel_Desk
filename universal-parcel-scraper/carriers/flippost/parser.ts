import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { flippostStage, PLANNED_DISPATCH } from './status.js';

export const PROVIDER = 'Flip Post';
// A long history is a few kilobytes.
export const FLIPPOST_MAX_BYTES = 256 * 1024;
// "29/07/18 13:25": day, month, two-digit year and an optional clock, as the rows give them.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}))?$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
// A wall clock without an offset can be an instant up to 14 hours before it.
const EARLIEST_OFFSET_MS = 14 * 3_600_000;

type Row = Record<string, unknown>;

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Row, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Flip Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The rows of a `getTrackInfo` reply. `success` false is a request the API did not complete,
 * and its message names no waybill, so it is inconclusive. An empty list is the API's answer
 * for a waybill it holds nothing for.
 */
export function flippostRows(payload: unknown): Row[] {
  if (!isRecord(payload)) invalid('Flip Post returned an invalid envelope');
  if (payload.success === false) throw new IndeterminateError(PROVIDER, 'Flip Post did not complete the lookup');
  if (payload.success !== true) invalid('Flip Post returned an invalid envelope');
  const data = payload.data;
  if (!Array.isArray(data)) invalid('Flip Post returned an invalid list of rows');
  if (data.length > MAX_ROWS) invalid('Flip Post returned an oversized history');
  if (!data.every(isRecord)) invalid('Flip Post returned an invalid row');
  return data;
}

/**
 * A row's clock as a local day or wall time. Rows without a time come at 00:00, as the API
 * manual's example gives the same rows as days alone, so midnight keeps the day only.
 */
function rowClock(row: Row): string {
  const match = CLOCK.exec(text(row, 'atime', 20));
  const day = match ? calendarDay(2000 + Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day) invalid('Flip Post returned an invalid row time');
  const [hours, minutes] = [match[4], match[5]];
  if (hours === undefined || minutes === undefined || (hours === '00' && minutes === '00')) return day;
  if (Number(hours) > 23 || Number(minutes) > 59) invalid('Flip Post returned an invalid row time');
  return `${day}T${hours}:${minutes}:00`;
}

interface Scan {
  code: string;
  local: string;
  event: CarrierEvent;
}

/**
 * One row: its status (`astatus`), the town or leg after it (`aloc`) and its clock. The status
 * of a delivery names the receiver after a colon, and so does `trackinfo`, which repeats the
 * row: only the status before a colon is read.
 */
function projectRow(row: Row): Scan {
  const code = clean(text(row, 'astatus').split(':')[0]);
  if (!code) invalid('Flip Post returned a row without its status');
  const place = text(row, 'aloc', 160);
  // "Прибыло в г." runs into its town, as the tracker writes it.
  const description = place ? `${code}${code.endsWith('.') ? '' : ' '}${place}` : code;
  // A leg is "origin - destination", and its row is made at the origin.
  const towns = place.split(' - ');
  const location = towns.length <= 2 && towns.every(Boolean) ? towns[0]! : '';
  const local = rowClock(row);
  return { code, local, event: { local_time: local, ...(location ? { location } : {}), description, provider_code: code } };
}

/** Whether a local clock is still to come at every offset it could have. */
function stillToCome(local: string, now: number): boolean {
  return Date.parse(`${local.length === 10 ? `${local}T00:00:00` : local}Z`) - EARLIEST_OFFSET_MS > now;
}

/**
 * The reply of `api.php?dbAct=getTrackInfo&wbno=…` for one waybill: its rows oldest first. The
 * rows do not name the waybill. A planned dispatch date is the waybill's registration as its
 * first row and in transit once the parcel has moved; one still to come is no scan.
 */
export function parseFlippost(payload: unknown, now = Date.now()): CarrierResult {
  const rows = flippostRows(payload);
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    const key = JSON.stringify([scan.local, scan.event.description, scan.event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  // Oldest first, as the API lists them; a reply listed newest first is turned round.
  if (scans.length > 1 && scans[0]!.local.slice(0, 10) > scans.at(-1)!.local.slice(0, 10)) scans.reverse();

  let moved = false;
  const toCome: CarrierEvent[] = [];
  const kept: CarrierEvent[] = [];
  for (const scan of scans) {
    const isPlanned = scan.code === PLANNED_DISPATCH;
    const stage: Stage | undefined = isPlanned ? (moved ? 'in_transit' : 'registered') : flippostStage(scan.code);
    if (!isPlanned) moved = true;
    const event = stage ? { ...scan.event, stage, stage_source: 'carrier_map' } : scan.event;
    (isPlanned && stillToCome(scan.local, now) ? toCome : kept).push(event);
  }
  const events = kept.reverse();

  // Only dispatches still to come: the waybill is booked, and nothing has happened to it yet.
  if (!events.length) {
    return { status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: toCome.at(-1)!.description!, last_update: null, expected_delivery: null, summary_only: true, events: [] };
  }
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The answer for a waybill asked in each of its readings: the one reading with rows. Both
 * readings of an eight-digit number can be waybills, so rows for both settle nothing; none is
 * not found.
 */
export function settleFlippost(payloads: readonly unknown[], now = Date.now()): CarrierResult {
  if (!payloads.length) throw new IndeterminateError(PROVIDER, 'Flip Post was not asked');
  const found = payloads.filter((payload) => flippostRows(payload).length > 0);
  if (found.length > 1) {
    throw new IndeterminateError(PROVIDER, 'Flip Post has a waybill for both readings of the number', { reason: 'several_parcels' });
  }
  return parseFlippost(found[0] ?? payloads[0], now);
}
