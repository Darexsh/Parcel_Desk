import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { posIndonesiaStage } from './status.js';

export const PROVIDER = 'Pos Indonesia';
// A long history is a few kilobytes.
export const POS_INDONESIA_MAX_BYTES = 512_000;

// A waybill: P, its posting date as YYMMDD, then seven digits, as the `pos-indonesia-1` rule reads it.
const WAYBILL = /^P\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}$/;
// The older domestic barcode.
const BARCODE = /^\d{11}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const STATE = /^[A-Z][A-Z0-9_]{0,39}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The service's answer, with HTTP 400, to a number it holds nothing for.
const NOT_FOUND = 'data not found';

/** A number for Pos Indonesia's service: a waybill, an older domestic barcode or an S10 item code, Indonesian or inbound. */
export function normalizePosIndonesiaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (WAYBILL.test(number) || BARCODE.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pos Indonesia numbers are waybills, eleven-digit barcodes or S10 item codes');
}

// A field the service leaves without a value, as in `"actual_weight":,`.
const EMPTY_VALUE = /("[A-Za-z_]+":)(?=\s*[,}\]])/g;

/**
 * The service's reply as JSON. For items it holds no waybill for, inbound
 * items among them, it fills its template with nothing for numeric fields,
 * which is not JSON; those fields are read as null.
 */
export function posIndonesiaPayload(text: string): unknown {
  const body = text.replace(/^\uFEFF/, '');
  try { return JSON.parse(body); }
  catch (cause) {
    try { return JSON.parse(body.replace(EMPTY_VALUE, '$1null')); }
    catch { throw new SchemaError(PROVIDER, 'Pos Indonesia returned invalid tracking JSON', { cause }); }
  }
}

/** The not-found notice; the service sends it with HTTP 400. */
export function isPosIndonesiaNotFound(payload: unknown): boolean {
  return isRecord(payload) && clean(payload.message, 80).toLowerCase() === NOT_FOUND;
}

// Who handled or received the item. Staff come in brackets after "oleh"
// ("by"); after a delivery, "diterima oleh" ("received by") names the
// recipient, then how they relate to the addressee.
const STAFF = /\s*\boleh\s*\([^()]*\)/gi;
const RECIPIENT = /\s*\bditerima\s+oleh\b[\s\S]*$/i;
const NAMED = /\s*\boleh\b[\s\S]*?(?=\s+(?:di|dan|dengan|ke|dari)\b|$)/gi;
// An Indonesian mobile number, written with or without the country code.
const PHONE = /(?<![\dA-Z])(?:\+?62|0)[\s.-]?8(?:[\s.-]?\d){7,11}(?![\dA-Z])/gi;
// An office's code after its name: its postcode, with a letter and digit for a
// counter or agent, or four digits and a letter for a delivery centre.
const OFFICE_CODE = /(?<=[A-Za-z.)])\s+(?:\d{5}(?:[A-Z]\d?)?|\d{4}[A-Z]\d?)(?=$|[\s,.;)])/g;

/**
 * A scan's wording without the staff member who scanned it, the recipient a
 * delivery names, phone numbers and office codes, which carry postcodes.
 */
export function posIndonesiaWording(content: string): string {
  return clean(content.replace(STAFF, '').replace(RECIPIENT, ' diterima').replace(NAMED, '')
    .replace(PHONE, '').replace(OFFICE_CODE, ''), 300).replace(/\s+([,.;:])/g, '$1');
}

/** An office's name without its code. */
function placeOf(value: unknown): string {
  return clean(clean(value, 160).replace(OFFICE_CODE, ''), 120);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pos Indonesia returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: the scanning office's wall clock, without a zone. Indonesia
 * keeps three and the service names none, so it stays a local time.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'date', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Pos Indonesia returned an invalid scan time');
  }
  return local;
}

interface Scan { readonly key: string; readonly event: CarrierEvent }

function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pos Indonesia returned an invalid scan');
  const code = text(row, 'connote_code', 64);
  if (!code) throw new SchemaError(PROVIDER, 'Pos Indonesia returned a scan without the item’s number');
  if (normalizeTrackingNumber(code).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Pos Indonesia answered for another shipment');
  const action = text(row, 'action', 60);
  const state = (text(row, 'connote_state', 40) || action).toUpperCase();
  if (!STATE.test(state)) throw new SchemaError(PROVIDER, 'Pos Indonesia returned a scan without a valid state');
  const local = scanClock(row);
  const description = posIndonesiaWording(text(row, 'content', 600)) || action || state;
  const location = placeOf(row.location_name);
  const staged = posIndonesiaStage(state, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: state,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, state, description, location]), event };
}

/** The history rows: a list, a single row, or nothing yet. */
function rowsOf(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) {
    if (value.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pos Indonesia returned an oversized history');
    return value;
  }
  if (isRecord(value)) return [value];
  throw new SchemaError(PROVIDER, 'Pos Indonesia returned an invalid history');
}

/** The waybill's weight, in grams; zero or nothing when it was not weighed. */
function weightOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value / 1000 : null;
}

/** The country a waybill goes to: an Indonesian postcode, or a country code for an item sent abroad. */
function destinationOf(value: unknown): string | null {
  const zone = cleanScalar(value, 16).toUpperCase();
  if (/^\d{5}$/.test(zone)) return 'ID';
  return /^[A-Z]{2}$/.test(zone) ? countryCode(zone) : null;
}

/**
 * The service's reply for one number: the waybill, then its history. The
 * waybill names the number it was made for, and is empty for an item the
 * service holds no waybill for; every scan names the item's number. Each must
 * be the whole requested number: the service also answers for a booking code.
 */
export function parsePosIndonesia(payload: unknown, raw: string): CarrierResult {
  const number = normalizePosIndonesiaNumber(raw);
  if (isPosIndonesiaNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'connote_history')) {
    throw new SchemaError(PROVIDER, 'Pos Indonesia did not return a tracking result');
  }
  const waybill = text(payload, 'connote_code', 64);
  if (waybill && normalizeTrackingNumber(waybill).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Pos Indonesia answered for another shipment');
  }
  const rows = rowsOf(payload.connote_history);
  if (!waybill && !rows.length) throw new SchemaError(PROVIDER, 'Pos Indonesia returned a reply that names no shipment');

  const seen = new Set<string>();
  const scans: Array<{ event: CarrierEvent; order: number }> = [];
  rows.forEach((row, order) => {
    const scan = scanOf(row, number);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push({ event: scan.event, order });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; of scans made the same second, the one the reply lists later.
  scans.sort((a, b) => String(b.event.local_time).localeCompare(String(a.event.local_time)) || b.order - a.order);
  const events = scans.map(scan => scan.event);

  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const weight = weightOf(payload.actual_weight);
  const country = destinationOf(payload.zone_code_to);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    // The service leaves out scans the tracking page shows, and those of the
    // foreign posts an international item passes through.
    history_truncated: true,
  };
}
