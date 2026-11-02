import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { twsStage } from './status.js';

export const PROVIDER = 'TWS Express';
// A long history is a few kilobytes.
export const TWS_MAX_BYTES = 512 * 1024;
// TWS's waybills: 28, four digits, a letter and six digits, or thirteen digits on older ones.
const WAYBILL = /^(?:28\d{4}[A-Z]\d{6}|\d{13})$/;
// The Poste Delivery Business waybills TWS delivers, which its tracker also follows.
const POSTE_BUSINESS = /^1UW[A-Z\d]{10}$/;
// The tracker's own words for a waybill it does not have.
const NOT_FOUND = /^Errore, ldv non trovata$/i;
// The record of the shipment's parcels the page lists apart; it carries no waybill.
const PARCELS = 'COLLO';
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MAX_LEGS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill for TWS's tracker, in capitals; anything else is not one it follows. */
export function normalizeTwsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!WAYBILL.test(number) && !POSTE_BUSINESS.test(number)) {
    throw new InvalidInputError(PROVIDER, 'TWS waybills are 28, four digits, a letter and six digits, or thirteen digits');
  }
  return number;
}

/** Whether a normalized number is one of TWS's own waybills rather than a Poste one it delivers. */
export function isTwsWaybill(number: string): boolean {
  return WAYBILL.test(number);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TWS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: `data` as day-month-year and `ora` to the second, Italy's
 * wall clock with no zone in the reply, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const day = DAY.exec(text(row, 'data', 16));
  const clock = CLOCK.exec(text(row, 'ora', 16));
  const local = day && clock ? `${day[3]}-${day[2]}-${day[1]}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'TWS returned an invalid scan time');
  }
  return local;
}

/** One scan: its wording, code and clock. The signer, the branch code and the note are not kept. */
function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = text(row, 'stato');
  if (!description) throw new SchemaError(PROVIDER, 'TWS returned a scan without wording');
  const code = cleanScalar(row.codiceStato, 16).toUpperCase();
  const local = scanClock(row);
  const staged = twsStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description]), event };
}

/** A scan of one parcel, which names the parcel's code; the page lists those apart. */
function parcelScan(scan: unknown): boolean {
  if (!isRecord(scan)) return false;
  const code = cleanScalar(scan.codice_collo, 64);
  return code !== '' && code !== 'null';
}

/** A calendar day as the reply writes it, or null. */
function estimate(value: string): string | null {
  const day = DAY.exec(value);
  if (!day) return null;
  const iso = `${day[3]}-${day[2]}-${day[1]}`;
  return DateTime.fromISO(iso, { zone: 'UTC' }).isValid ? iso : null;
}

/**
 * The reply of `/extracking/trackingStatusLdv` for one waybill. `stato` is
 * `OK` with the waybill's legs in `response`: the waybill itself, then a leg
 * per new consignment, such as `{number}/1` for a delivery after the parcel was
 * held. `WARN` with "ldv non trovata" is the tracker's not found; `KO` and
 * `ERR` are its own failures, which the page asks to retry later.
 */
export function parseTws(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTwsNumber(raw);
  if (!isRecord(payload) || typeof payload.stato !== 'string') throw new SchemaError(PROVIDER, 'TWS returned an invalid envelope');
  const state = payload.stato.trim().toUpperCase();
  if (state === 'WARN') {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.some((error) => typeof error === 'string' && NOT_FOUND.test(clean(error, 120)))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'TWS did not complete the lookup');
  }
  if (state === 'KO' || state === 'ERR') throw new IndeterminateError(PROVIDER, 'TWS did not complete the lookup');
  if (state !== 'OK') throw new SchemaError(PROVIDER, 'TWS returned an unknown lookup state');
  const records = payload.response;
  if (!Array.isArray(records) || records.length > MAX_LEGS) throw new SchemaError(PROVIDER, 'TWS returned invalid legs');

  // As on the page: the legs' scans of the whole shipment, else the scans of its parcels.
  const own = new RegExp(`^${number}(?:/\\d{1,3})?$`);
  const legs: Record<string, unknown>[] = [];
  const shipment: unknown[] = [];
  const parcels: unknown[] = [];
  for (const record of records) {
    if (!isRecord(record) || typeof record.ldv !== 'string') throw new SchemaError(PROVIDER, 'TWS returned a leg without its waybill');
    const rows: unknown = record.stati_tracking ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TWS returned a leg with invalid scans');
    const scans: unknown[] = rows;
    const waybill = clean(record.ldv, 64).toUpperCase();
    if (waybill === PARCELS) {
      parcels.push(...scans);
      continue;
    }
    if (!own.test(waybill)) throw new IndeterminateError(PROVIDER, 'TWS answered for another waybill');
    legs.push(record);
    for (const scan of scans) (parcelScan(scan) ? parcels : shipment).push(scan);
  }
  if (!legs.length) throw new SchemaError(PROVIDER, 'TWS answered without the waybill');
  const history = shipment.length ? shipment : parcels;
  if (history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TWS returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; order: number }[] = [];
  for (const row of history) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TWS returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ event: scan.event, order: scans.length });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The legs list their scans oldest first, so of two scans on
  // one clock the later in the reply is the newer.
  const events = scans.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.order - a.order)
    .map((scan) => scan.event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  // The newest leg's estimate, which the page does not show; a delivered or returned parcel has none.
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(text(legs.at(-1)!, 'eta', 16));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
