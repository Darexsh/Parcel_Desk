import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { forwardAirStage } from './status.js';

export const PROVIDER = 'Forward Air';
// A waybill with several shipments under it is a few kilobytes each.
export const FORWARD_AIR_MAX_BYTES = 512 * 1024;
// Eight digits, as Forward Air's help pages describe its waybill numbers.
const NUMBER = /^\d{8}$/;
// A clock as the reply writes it, month first and to the minute: "11/22/2026 12:33".
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
// The page shows a delivery window as two clocks joined by a hyphen.
const WINDOW = /^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})\s*-\s*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})$/;
const CODE = /^[A-Z]{2,8}$/;
// A station's code, such as an airport's.
const STATION = /^[A-Z0-9]{3,5}$/;
// Every place on these clocks in the United States keeps the same rules as the zone named.
// Mountain time is not read: Arizona keeps standard time all year, and the label does not say
// whether a scan is there.
const ZONES: Readonly<Record<string, string>> = { ET: 'America/New_York', CT: 'America/Chicago', PT: 'America/Los_Angeles' };
const POUNDS_TO_KG = 0.453_592_37;
const MAX_RESULTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill number for Forward Air's tracker; anything else is not one it issues. */
export function normalizeForwardAirNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Forward Air waybill numbers are eight digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Forward Air returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** "11/22/2026 12:33" as an offset-less ISO wall clock, or null when it is not a real one. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:00`;
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  return parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall ? wall : null;
}

/**
 * A scan's clock: the station's wall clock, which the reply names by its US
 * zone (`ET`, `CT`, `PT`), read as an instant there. Mountain time, another
 * label or none keeps the wall clock, and so does an hour the zone skips when
 * its clocks go forward.
 */
function scanClock(wall: string, label: string): { time: string } | { local_time: string } {
  const zone = Object.hasOwn(ZONES, label) ? ZONES[label]! : null;
  if (!zone) return { local_time: wall };
  const read = firstOccurrence(DateTime.fromISO(wall, { zone }));
  if (!read.isValid || read.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) return { local_time: wall };
  return { time: read.toISO({ suppressMilliseconds: true }) };
}

interface Scan {
  key: string;
  wall: string;
  event: CarrierEvent;
}

/**
 * One row of a shipment's `Statuses`. Its code, wording, station, clock and
 * zone are read; the weights, the manifest and who recorded the scan (which
 * the page shows as the signatory) are not.
 */
function projectRow(row: Record<string, unknown>): Scan {
  const code = text(row, 'statusCode', 16).toUpperCase();
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Forward Air returned a scan without its code');
  const description = text(row, 'StatusDescription');
  if (!description) throw new SchemaError(PROVIDER, 'Forward Air returned a scan without wording');
  const wall = wallClock(text(row, 'RecordDate', 32));
  if (!wall) throw new SchemaError(PROVIDER, 'Forward Air returned an invalid scan time');
  const station = text(row, 'AirportCode', 16).toUpperCase();
  const location = STATION.test(station) ? station : '';
  const staged = forwardAirStage(code, description);
  const event: CarrierEvent = {
    ...scanClock(wall, text(row, 'TimeZoneCode', 8).toUpperCase()),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([wall, code, description, location]), wall, event };
}

interface Shipment {
  record: Record<string, unknown>;
  /** Newest first. */
  scans: Scan[];
  newest: string;
}

function readShipment(record: Record<string, unknown>): Shipment {
  const rows = record.Statuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Forward Air returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Forward Air returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Forward Air returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // Newest first, as the reply lists them; an oldest-first list is turned round.
  if (scans.length > 1 && scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();
  // The summary's `RecordDate` is its latest status, which dates a shipment without scans too.
  const newest = scans.reduce((latest, scan) => (scan.wall > latest ? scan.wall : latest), wallClock(text(record, 'RecordDate', 32)) ?? '');
  return { record, scans, newest };
}

/** The day of a clock the reply gives, or null when it is missing or not a real one. */
function day(value: string): string | null {
  return wallClock(value)?.slice(0, 10) ?? null;
}

/**
 * The day the page shows as the expected delivery: the end of the delivery
 * window when there is one, else the day the freight is due at the
 * destination station.
 */
function estimate(record: Record<string, unknown>): string | null {
  const window = WINDOW.exec(text(record, 'EstimatedDeliveryRange', 64));
  if (window) return day(window[2]!);
  return day(text(record, 'EstimatedAvailableDate', 32));
}

/** The shipment's weight, which the reply gives in pounds (`WeightType` `L`), in kilograms. */
function weight(record: Record<string, unknown>): number | null {
  const value = record.Weight;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || text(record, 'WeightType', 4).toUpperCase() !== 'L') return null;
  return Math.round(value * POUNDS_TO_KG * 1000) / 1000;
}

// The answer for a waybill the tracker does not know, which echoes the number asked.
const NOT_FOUND = /^No waybills found\.?\s+(\S+)$/i;

/**
 * The reply of `tracking/shipments` for one waybill, the lookup Forward Air's
 * tracking page makes: `{"errors":[…],"results":[…]}`. A waybill it does not
 * know comes back without results and with `No waybills found. {number}`.
 * Forward Air reuses waybill numbers, so one can hold shipments years apart,
 * and the tracker also finds a shipment by its customer's reference: only a
 * shipment whose `AirbillNumber` is the number asked counts, and the newest
 * of those is read.
 */
export function parseForwardAir(payload: unknown, raw: string): CarrierResult {
  const number = normalizeForwardAirNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new SchemaError(PROVIDER, 'Forward Air returned an invalid envelope');
  const errors = payload.errors ?? [];
  if (!Array.isArray(errors) || errors.some((error) => typeof error !== 'string')) {
    throw new SchemaError(PROVIDER, 'Forward Air returned invalid errors');
  }
  const results: unknown[] = payload.results;
  if (results.length > MAX_RESULTS) throw new SchemaError(PROVIDER, 'Forward Air returned too many shipments');

  const shipments: Shipment[] = [];
  for (const record of results) {
    if (!isRecord(record) || typeof record.AirbillNumber !== 'string') {
      throw new SchemaError(PROVIDER, 'Forward Air returned a shipment without its waybill number');
    }
    if (clean(record.AirbillNumber, 64) === number) shipments.push(readShipment(record));
  }
  if (!shipments.length) {
    const unknown = errors.length === 1 && NOT_FOUND.exec(clean(errors[0], 200))?.[1] === number;
    if (unknown) throw new NotFoundError(PROVIDER);
    if (results.length) throw new IndeterminateError(PROVIDER, 'Forward Air answered for another shipment');
    throw new IndeterminateError(PROVIDER, 'Forward Air did not complete the lookup');
  }
  // The newest shipment under the waybill, the reply's first on a tie. Shipments years apart
  // compare on their wall clocks whatever their zones.
  const shipment = shipments.reduce((latest, other) => (other.newest > latest.newest ? other : latest));
  const events = shipment.scans.map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  // A delivery ends the shipment: a scan recorded after it, such as a late arrival, moves nothing.
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = delivery ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(shipment.record);
  const kilograms = weight(shipment.record);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
