import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { euroexpressStage } from './status.js';

export const PROVIDER = 'EuroExpress';
export const CARRIER = 'euroexpress-ba';
// A shipment with its scans is under five kilobytes; an unknown code's error is about three.
export const EUROEXPRESS_MAX_BYTES = 256 * 1024;
// The shipment code printed on the waybill.
const NUMBER = /^\d{9}$/;
// A clock as the reply writes it, "2026-03-02T09:37:00.000+0100", with or without its offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/;
const WEIGHT = /^\d{1,5}(?:[.,]\d{1,3})?$/;
const MAX_ROWS = 300;

/** A code EuroExpress's tracker takes, without spaces; anything else is not one it issues. */
export function normalizeEuroexpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'EuroExpress shipment codes are nine digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `EuroExpress returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock. With an offset it is an instant, which the page shows in its
 * visitor's zone; without one it stays the wall clock it is.
 */
function scanClock(value: string): { wall: string; clock: { time?: string; local_time?: string } } {
  const [, date, minutes, offset] = CLOCK.exec(value) ?? [];
  const wall = `${date}T${minutes?.length === 5 ? `${minutes}:00` : minutes}`;
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over to the next day.
  const calendar = date ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!calendar?.isValid || calendar.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid scan time');
  }
  if (!offset) return { wall, clock: { local_time: wall } };
  const at = DateTime.fromISO(`${wall}${offset}`, { setZone: true });
  if (!at.isValid) throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid scan time');
  return { wall, clock: { time: at.toISO({ suppressMilliseconds: true }) } };
}

/** One row of `events`: when, the centre that scanned it and what happened. */
function scan(row: unknown): { key: string; wall: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid scan');
  const description = text(row, 'opis', 300);
  if (!description) throw new SchemaError(PROVIDER, 'EuroExpress returned a scan without wording');
  const { wall, clock } = scanClock(text(row, 'datum', 40));
  const location = text(row, 'centar', 120);
  const staged = euroexpressStage(null, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.time ?? wall, description.toLowerCase(), location]), wall, event };
}

/** The status code of the shipment's summary: a whole number, or nothing. */
function statusCode(payload: Record<string, unknown>): string {
  const value = payload.status;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid status');
  }
  return String(value);
}

/** The weight the page shows in kilograms; nothing for an empty or zero weight. */
function weight(payload: Record<string, unknown>): Pick<CarrierResult, 'weight_kg'> {
  const value = payload.tezina;
  if (value === null || value === undefined || value === '') return {};
  const kilograms = typeof value === 'number' ? value
    : typeof value === 'string' && WEIGHT.test(value.trim()) ? Number(value.trim().replace(',', '.')) : Number.NaN;
  if (!Number.isFinite(kilograms) || kilograms < 0) throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid weight');
  return kilograms > 0 ? { weight_kg: kilograms } : {};
}

/**
 * The reply of the lookup EuroExpress's tracking page makes for one code
 * (HTTP 200): the shipment's summary and its scans. The shipment must carry
 * the whole code asked. Neither the person who took the parcel, its
 * description and value nor its dates of sending and receipt are kept.
 */
export function parseEuroexpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEuroexpressNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'EuroExpress returned an invalid reply');
  if (typeof payload.sifra !== 'string' || !clean(payload.sifra, 64)) throw new SchemaError(PROVIDER, 'EuroExpress returned a shipment without its code');
  if (normalizeTrackingNumber(clean(payload.sifra, 64)) !== number) throw new IndeterminateError(PROVIDER, 'EuroExpress answered for another shipment');

  const rows: unknown = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'EuroExpress returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'EuroExpress returned an oversized history');
  const seen = new Set<string>();
  const scans: { wall: string; event: CarrierEvent }[] = [];
  for (const row of rows as unknown[]) {
    const { key, wall, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ wall, event });
  }
  // Newest first; a reply that lists them oldest first is turned round.
  if (scans.length > 1 && scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();
  const events = scans.map((item) => item.event);

  const code = statusCode(payload);
  const wording = text(payload, 'statusOpis', 120);
  const summary = code || wording ? euroexpressStage(code || null, wording) : null;
  const facts = weight(payload);
  if (!events.length) {
    // The tracker can keep a shipment's status without its scans: the summary stands alone.
    if (!code && !wording) throw new NoHistoryError(PROVIDER);
    return {
      status: summary ? languageStageStatus(summary.stage) : 'unknown',
      ...(summary ? { current_stage: summary.stage, current_stage_source: summary.source } : {}),
      last_status_text: wording || null,
      ...(code ? { provider_code: code } : {}),
      last_update: null,
      expected_delivery: null,
      ...facts,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The summary is the shipment's current status; the scans are its history.
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary ? summary.source : scanned?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...facts,
    events,
  };
}

/**
 * The lookup's answer to a code it does not know: HTTP 404 with an error that
 * names the whole code asked. Any other 404 is a moved or broken route.
 */
export function isEuroexpressMissing(payload: unknown, raw: string): boolean {
  const number = normalizeEuroexpressNumber(raw);
  if (!isRecord(payload) || payload.statusCode !== 404 || !isRecord(payload.exception)) return false;
  return clean(payload.exception.errorMess, 200) === `Package with trackingNumber of ${number} not found`;
}
