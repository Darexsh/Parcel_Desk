import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pdnExpressStage } from './status.js';

export const PROVIDER = 'PDN Express';
// A long history is about ten kilobytes.
export const PDN_EXPRESS_MAX_BYTES = 256 * 1024;
// PDN and ten digits, as the parcel label prints it.
const NUMBER = /^PDN\d{10}$/;
const CODE = /^[A-Z0-9_]{1,32}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The offset the reply states beside a scan's zone: "UTC+2", "UTC-4", "UTC+0".
const UTC_OFFSET = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/;
// The tracker's notice for a number it has no parcel for, in the English the lookup asks.
const NOT_FOUND = /tracking attempt was not successful|check your tracking number/i;
// The page's own errors when the service behind it fails.
const UNAVAILABLE = new Set(['upstream', 'network']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A PDN Express number in capitals; anything else is not one it issues. */
export function normalizePdnExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PDN Express numbers are PDN and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PDN Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock. `eventTime` is a wall clock in the scan's `timezone`, and
 * `utcTimezone` states that zone's offset at the time. The clock becomes an
 * instant when both agree; otherwise it stays the wall clock it is.
 */
function scanClock(row: Record<string, unknown>): { time: string } | { local_time: string } {
  const wall = WALL_CLOCK.exec(text(row, 'eventTime', 32));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  // Parsing in UTC checks the calendar digits only.
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!wall || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'PDN Express returned an invalid scan time');
  }
  const zone = text(row, 'timezone', 64);
  const offset = UTC_OFFSET.exec(text(row, 'utcTimezone', 16));
  if (offset && Number(offset[2]) <= 14 && Number(offset[3] ?? 0) < 60 && zone && IANAZone.isValidZone(zone)) {
    const instant = DateTime.fromISO(`${local}${offset[1]}${offset[2]!.padStart(2, '0')}:${offset[3] ?? '00'}`, { setZone: true });
    // The stated offset also settles a wall clock the zone repeats when its clocks go back.
    if (instant.isValid && instant.setZone(zone).offset === instant.offset) return { time: instant.toISO({ suppressMilliseconds: true }) };
  }
  return { local_time: local };
}

function sortKey(event: CarrierEvent): number {
  return typeof event.time === 'string'
    ? DateTime.fromISO(event.time, { setZone: true }).toMillis()
    : DateTime.fromISO(event.local_time as string, { zone: 'UTC' }).toMillis();
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = text(row, 'eventCode', 32).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'PDN Express returned an invalid scan code');
  const label = isRecord(row.statusCodeConfig) ? text(row.statusCodeConfig, 'lanName', 120) : '';
  // The page's line for the scan: its own wording, else the status's name.
  const description = text(row, 'eventDesc') || label;
  if (!description) throw new SchemaError(PROVIDER, 'PDN Express returned a scan without wording');
  const when = scanClock(row);
  // A pickup point's scan names the point; the page shows its details only for the delivery postcode.
  const location = row.pickupSite ? '' : text(row, 'eventLocation', 120);
  const staged = pdnExpressStage(code, description);
  const event: CarrierEvent = {
    ...when,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([when, code, description, location]), event };
}

/**
 * The reply of the tracking page's `/api/track` search for one number:
 * `{"ok":true,"data":[…]}` with one entry per number asked. An entry must name
 * the number asked. An unknown number's entry has no scans and the tracker's
 * notice that the lookup was not successful.
 */
export function parsePdnExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizePdnExpressNumber(raw);
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') throw new SchemaError(PROVIDER, 'PDN Express returned an invalid envelope');
  if (!payload.ok) {
    if (UNAVAILABLE.has(text(payload, 'error', 40))) throw new IndeterminateError(PROVIDER, 'PDN Express could not reach its tracking service');
    throw new SchemaError(PROVIDER, 'PDN Express rejected the lookup');
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'PDN Express returned a reply without shipments');
  if (payload.data.some((entry) => !isRecord(entry) || typeof entry.orderNo !== 'string')) {
    throw new SchemaError(PROVIDER, 'PDN Express returned a shipment without its number');
  }
  const entry = (payload.data as Record<string, unknown>[])
    .find((candidate) => returnedTrackingNumber(candidate.orderNo).toUpperCase() === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'PDN Express answered for another shipment');
  const rows = entry.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PDN Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PDN Express returned an oversized history');
  const destination = text(entry, 'destCountry', 80);
  if (!rows.length) {
    const notice = isRecord(entry.statusCodeConfig) ? text(entry.statusCodeConfig, 'lanName', 300) : '';
    if (!destination && NOT_FOUND.test(notice)) throw new NotFoundError(PROVIDER);
    if (notice) throw new IndeterminateError(PROVIDER, 'PDN Express answered with another notice');
    throw new NoHistoryError(PROVIDER);
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PDN Express returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  // Newest first, as the reply and the page list them; an oldest-first reply is turned round.
  const newestFirst = sortKey(events[0]!) < sortKey(events.at(-1)!) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && typeof current!.time === 'string' ? current!.time : null;
  const country = countryCode(destination);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
