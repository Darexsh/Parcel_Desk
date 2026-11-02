import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bussgodsStage } from './status.js';

export const PROVIDER = 'Bussgods';
// A long history is a few kilobytes.
export const BUSSGODS_MAX_BYTES = 512 * 1024;

const ZONE = 'Europe/Stockholm';
// A fraktsedel number: ten digits, printed with BG in front.
const NUMBER = /^(?:BG)?\d{10}$/;
// "2025-07-29T08:29:28": a Swedish wall clock. An offset, should the reply carry one, is kept.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
// The page names no agent for this station.
const NO_AGENT = 5399;
// Handed out at the agent (current and older code), as opposed to a door delivery.
const HANDED_OUT = new Set(['13', '3']);
const MAX_ROWS = 500;

/** A fraktsedel number in capitals; anything else is not a number Bussgods issues. */
export function normalizeBussgodsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bussgods fraktsedel numbers are ten digits, with or without BG in front');
  return number;
}

/** The ten digits of a fraktsedel number, which the tracker answers with or without its BG. */
const digits = (number: string) => number.replace(/^BG(?=\d{10}$)/, '');

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bussgods returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional whole number; anything else is a changed reply. */
function integer(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new SchemaError(PROVIDER, `Bussgods returned an invalid ${key}`);
  return value as number;
}

/** A scan's instant: a wall clock read in Sweden, or the offset the reply gives. */
function scanTime(value: string): string {
  const [, wall, offset] = CLOCK.exec(value) ?? [];
  // Parsing in UTC checks the calendar fields only.
  const calendar = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !calendar?.isValid || calendar.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Bussgods returned an invalid scan time');
  }
  const parsed = offset ? DateTime.fromISO(`${wall}${offset}`, { setZone: true }) : firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  return parsed.toISO({ suppressMilliseconds: true })!;
}

interface Scan {
  event: CarrierEvent;
  /** The agent the page names for the scan. */
  agent: string;
}

/** One row of `Statuses`, which must belong to the fraktsedel asked. */
function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bussgods returned an invalid scan');
  const named = text(row, 'ShipmentNumber', 64).toUpperCase();
  if (named && digits(named) !== digits(number)) throw new IndeterminateError(PROVIDER, 'Bussgods answered for another shipment');
  // The parcel the scan is for is checked, not kept.
  text(row, 'ParcelNumber', 64);
  const code = integer(row, 'StatusCode');
  if (code === null) throw new SchemaError(PROVIDER, 'Bussgods returned a scan without its status code');
  const description = text(row, 'StatusDescription', 300);
  if (!description) throw new SchemaError(PROVIDER, 'Bussgods returned a scan without wording');
  const time = scanTime(text(row, 'Timestamp', 40));
  const location = text(row, 'CityName', 120);
  const station = integer(row, 'StationNumber');
  const name = text(row, 'StationName', 120);
  const staged = bussgodsStage(String(code), description);
  return {
    agent: station === NO_AGENT ? '' : name,
    event: {
      time,
      ...(location ? { location } : {}),
      description,
      provider_code: String(code),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/**
 * The reply of `/api/transshipment/{number}`, the lookup the tracking page
 * makes: the fraktsedel's `Information` and its `Statuses`, oldest first. The
 * page reports any reply without scans as no result; for an unknown number the
 * information names the number asked, or none.
 */
export function parseBussgods(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBussgodsNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.Information) || !Array.isArray(payload.Statuses)) {
    throw new SchemaError(PROVIDER, 'Bussgods returned an invalid reply');
  }
  const information = payload.Information;
  const named = text(information, 'ShipmentNumber', 64).toUpperCase();
  if (named && digits(named) !== digits(number)) throw new IndeterminateError(PROVIDER, 'Bussgods answered for another shipment');
  const product = integer(information, 'ProductCode');
  const service = product ? text(information, 'ProductName', 80) : '';
  const parcels = information.ParcelNumbers ?? [];
  if (!Array.isArray(parcels)) throw new SchemaError(PROVIDER, 'Bussgods returned invalid parcel numbers');
  const rows: unknown[] = payload.Statuses;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bussgods returned an oversized history');
  if (!rows.length) {
    // A fraktsedel the reply describes exists, but has no scan yet.
    if (product || parcels.length || text(information, 'ToCityName', 120)) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  if (!named && !rows.some((row) => isRecord(row) && typeof row.ShipmentNumber === 'string' && row.ShipmentNumber.trim())) {
    throw new SchemaError(PROVIDER, 'Bussgods returned scans without their shipment number');
  }

  const seen = new Set<string>();
  const scans: Scan[] = [];
  // Newest first; scans of one clock keep the reply's order, turned round.
  for (const row of [...rows].reverse()) {
    const scan = scanOf(row, number);
    // Each parcel of the fraktsedel can repeat a scan.
    const identity = JSON.stringify([scan.event, scan.agent]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  scans.sort((a, b) => Date.parse(b.event.time!) - Date.parse(a.event.time!));
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const index = events.findIndex((event) => event.stage);
  const current = index < 0 ? undefined : scans[index]!;
  const stage = current?.event.stage as Stage | undefined;
  // The agent the parcel waits at, or was collected from when it was handed out there.
  const older = scans.slice(index + 1);
  const waiting = stage === 'ready_for_pickup' ? current
    : stage === 'delivered' && HANDED_OUT.has(current!.event.provider_code!) && lastMovement(older.map(({ event }) => event)) === 'ready_for_pickup'
      ? older.find(({ event }) => event.stage === 'ready_for_pickup') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.event.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.event.time! } : {}),
    ...(waiting?.agent ? { pickup_point: waiting.agent } : {}),
    ...(service ? { service_name: service } : {}),
    events,
  };
}
