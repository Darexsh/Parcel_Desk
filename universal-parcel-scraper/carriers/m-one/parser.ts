import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mOneStage } from './status.js';

export const PROVIDER = 'M-ONE';
// A history of thirty scans is about ten kilobytes.
export const M_ONE_MAX_BYTES = 256 * 1024;
// The UPU S10 layout with Serbia's code, and the letters RS with twelve digits
// that the tracker's own fallback reply shows.
const NUMBER = /^(?:[A-Z]{2}\d{9}RS|RS\d{12})$/;
// A wall clock with no zone; the creation of a pickup order carries fractions of a second.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The placeholder the page's fallback reply puts in an empty field.
const PLACEHOLDER = /^[/-]*$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for M-ONE's tracker, in capitals; anything else is not one it issues. */
export function normalizeMOneNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'M-ONE numbers are two letters, nine digits and RS, or RS and twelve digits');
  return number;
}

/** An optional text field without the page's placeholder; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `M-ONE returned an invalid ${key}`);
  const cleaned = clean(value, maxLength);
  return PLACEHOLDER.test(cleaned) ? '' : cleaned;
}

/**
 * A scan's clock, `datumStatusa`. The reply names no zone and the page shows
 * the reading as it is, so it stays a wall clock, to the second.
 */
function scanClock(row: Record<string, unknown>): string {
  const local = CLOCK.exec(text(row, 'datumStatusa', 40))?.[1];
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : undefined;
  if (!local || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'M-ONE returned an invalid scan time');
  }
  return local;
}

/**
 * One row of the reply: the scan's code, wording, clock and depot. The
 * sender's and recipient's names the reply puts in its `posiljalacMesto` and
 * `primalacMesto` fields are never read.
 */
function projectRow(row: Record<string, unknown>, number: string): { key: string; event: CarrierEvent } {
  const named = text(row, 'brojPosiljke', 64).toUpperCase();
  if (!named) throw new SchemaError(PROVIDER, 'M-ONE returned a scan without its number');
  if (named !== number) throw new IndeterminateError(PROVIDER, 'M-ONE answered for another shipment');
  const code = text(row, 'status', 16).toUpperCase();
  const description = text(row, 'nazivStatus');
  if (!description) throw new SchemaError(PROVIDER, 'M-ONE returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'distributivniCentarNaziv', 120);
  const staged = mOneStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The parcel's weight in kilograms, as the page shows it. */
function weight(row: Record<string, unknown>): number | undefined {
  const value = row.tezina;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10_000 ? value : undefined;
}

/**
 * The reply of `api.m-one.rs/api/statushistory/{number}`: an array with one
 * row per scan, oldest first, each naming the parcel's number. A number the
 * tracker does not know is an HTTP 404, which the adapter reads. Every row
 * must name the number asked.
 */
export function parseMOne(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMOneNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'M-ONE returned an invalid reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'M-ONE returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of payload) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'M-ONE returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page reads it; a reply already newest first stays as it is.
  const newestFirst = (events[0]!.local_time as string) <= (events.at(-1)!.local_time as string) ? events.reverse() : events;

  // Every row repeats the parcel's weight and countries.
  const latest = payload.at(-1) as Record<string, unknown>;
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const kilograms = weight(latest);
  const country = text(latest, 'primalacSifraZemlje', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
