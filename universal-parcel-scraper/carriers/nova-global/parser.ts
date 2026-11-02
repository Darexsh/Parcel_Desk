import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { novaGlobalStage } from './status.js';

export const PROVIDER = 'Nova Global';
// A long history is a few kilobytes.
export const NOVA_GLOBAL_MAX_BYTES = 512 * 1024;
// Two letters, nine to sixteen digits and NPG, as rule nova-global-1 claims.
const NUMBER = /^[A-Z]{2}\d{9,16}NPG$/;
const WALL_CLOCK = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The page's script reads this reply as a number the tracker does not know.
const NOT_FOUND = 203;

/** A Nova Global waybill, in capitals; anything else is not a number it issues. */
export function normalizeNovaGlobalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Nova Global waybills are two letters, nine to sixteen digits and NPG');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Nova Global returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A two-letter country code the reply gives, or nothing. */
function country(row: Record<string, unknown>, key: string): string {
  const code = text(row, key, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && countryCode(code) === code ? code : '';
}

/**
 * A scan's clock. `date` is a wall clock with no zone, and `timestamp` the
 * instant the tracker makes of it by reading every wall clock on Kyiv time.
 * Scans abroad keep the scanning site's own clock, which that reading
 * misplaces, so the instant counts only where it reads back to the wall
 * clock in the zone of the country the scan names: in practice Ukraine.
 * Every other scan keeps its wall clock.
 */
function clockOf(row: Record<string, unknown>, place: string): { time: string } | { local_time: string } {
  const wall = WALL_CLOCK.exec(text(row, 'date', 32));
  const local = wall ? `${wall[1]}-${wall[2]}-${wall[3]}T${wall[4]}:${wall[5]}:${wall[6]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!wall || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Nova Global returned an invalid scan time');
  }
  const zone = place ? countryTimeZone(place) : null;
  const stamp = row.timestamp;
  if (zone && typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0) {
    const instant = DateTime.fromSeconds(stamp, { zone });
    const time = instant.isValid && instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? instant.toISO({ suppressMilliseconds: true }) : null;
    if (time) return { time };
  }
  return { local_time: local };
}

/**
 * The scan's line, which starts with the name of the country the scan names
 * and a full stop ("Ukraine.Delivered"); the name becomes its location.
 */
function wordingOf(status: string, place: string): { description: string; location: string } {
  const stop = status.indexOf('.');
  const name = stop > 0 ? status.slice(0, stop).trim() : '';
  const rest = stop > 0 ? clean(status.slice(stop + 1)) : '';
  if (place && name && rest && countryCode(name) === place) return { description: rest, location: name };
  return { description: status, location: place };
}

function projectRow(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Nova Global returned an invalid scan');
  const status = text(row, 'status');
  if (!status) throw new SchemaError(PROVIDER, 'Nova Global returned a scan without wording');
  const place = country(row, 'location');
  const { description, location } = wordingOf(status, place);
  const code = text(row, 'code', 16);
  const staged = novaGlobalStage(code, description);
  const event: CarrierEvent = {
    ...clockOf(row, place),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([text(row, 'date', 32), code, status]), event };
}

/**
 * The partner the reply says delivers the parcel, with its number. `bills`
 * lists the parcel's other numbers without saying whose each is: the sending
 * carrier's, Nova Poshta's waybill and the partner's. The partner's number is
 * the only one of the partner's own shape; with none or several, there is no
 * hand-off.
 */
function handoff(payload: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const name = text(payload, 'partner', 80);
  const partner = name ? carrierIdFromPartner(name) : undefined;
  const bills = payload.bills;
  if (!partner || partner === 'nova-global' || typeof bills !== 'string' || bills.length > 4096) return {};
  const references = new Set(bills.split(',').map((bill) => returnedTrackingNumber(bill))
    .filter((bill) => /^[A-Z0-9]{4,40}$/.test(bill) && bill !== number));
  const theirs = [...references].filter((bill) => (detectCarrierMatch(bill).candidates as string[]).includes(partner));
  return theirs.length === 1 ? { delivery_carrier: partner, delivery_tracking_number: theirs[0]! } : {};
}

/**
 * The reply of `tracking.php` for one waybill: the summary of its newest scan,
 * the route's two country codes, the parcel's other numbers, its delivery
 * partner and `historyStatus`, its scans newest first. They keep that order:
 * their clocks are not all instants. The tracker echoes the number asked as
 * `billNumber`. An empty body, the reply to a number it does not know, is
 * read before this.
 */
export function parseNovaGlobal(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNovaGlobalNumber(raw);
  if (payload === NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || typeof payload.billNumber !== 'string') throw new SchemaError(PROVIDER, 'Nova Global returned a reply without its waybill');
  if (returnedTrackingNumber(payload.billNumber) !== number) throw new IndeterminateError(PROVIDER, 'Nova Global answered for another waybill');
  const rows = payload.historyStatus ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Nova Global returned a waybill with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Nova Global returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = country(payload, 'to');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...handoff(payload, number),
    ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
