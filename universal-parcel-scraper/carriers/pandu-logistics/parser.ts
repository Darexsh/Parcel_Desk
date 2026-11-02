import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar, escapeRegExp } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { panduLogisticsMappedStage, panduLogisticsStage } from './status.js';

export const PROVIDER = 'Pandu Logistics';
// A delivered history of nine scans is about eight kilobytes, its scans written out three times.
export const PANDU_LOGISTICS_MAX_BYTES = 512 * 1024;
// A POD number has eleven digits; some AWB numbers have letters before the digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// The notice the page shows for a number the tracker holds no shipment under.
const NOT_FOUND = /your tracking ID is not found/i;
// A scan's clock as the tracker writes it: "26 Mar 2026 13:24".
const CLOCK = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The delivery scan names the receiver and repeats its own clock: "RECEIVED BY …, DATE 26 MAR 2026 19:01".
const RECEIVER = /^(RECEIVED)\s+BY\b[\s\S]*$/i;
// A branch arrival names the branch after Pandu Siwi Sentosa's initials: "ARRIVED AT PSS SURABAYA".
const BRANCH = /\bAT PSS\s+(\S.*)$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;

/** A number for Pandu Logistics' tracker, in upper case; anything else is not one it issues. */
export function normalizePanduLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pandu Logistics numbers are eight or more letters and digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string or a number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') invalid(`Pandu Logistics returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A scan's wall clock as `YYYY-MM-DDTHH:mm:00`. The tracker names no zone, and its branches span three. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) invalid('Pandu Logistics returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:00`;
}

/** Patterns that find the shipment's own names, which a scan could carry. */
function namePatterns(names: readonly string[]): RegExp[] {
  return names.filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'));
}

/**
 * A scan's wording without people: the delivery scan keeps `RECEIVED`, and
 * every scan loses the shipment's names and phone numbers.
 */
export function panduLogisticsWording(details: string, names: readonly RegExp[] = []): string {
  const own = clean(details).replace(RECEIVER, '$1');
  const scrubbed = names.reduce((line, name) => line.replace(name, ' '), own).replace(PHONE, ' ');
  return clean(scrubbed).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Row { key: string; event: CarrierEvent }

function projectRow(row: unknown, names: readonly RegExp[]): Row {
  if (!isRecord(row)) invalid('Pandu Logistics returned an invalid scan');
  const local = wallClock(text(row, 'date', 40));
  const description = panduLogisticsWording(text(row, 'details'), names);
  if (!description) invalid('Pandu Logistics returned a scan without its details');
  const location = BRANCH.exec(description)?.[1] ?? '';
  const staged = panduLogisticsStage(description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description]), event };
}

/** The scans newest first and once each; the tracker lists them oldest first. */
function history(rows: unknown, names: readonly RegExp[]): CarrierEvent[] {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) invalid('Pandu Logistics returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) invalid('Pandu Logistics returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectRow(row, names);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  const oldestFirst = events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string);
  return oldestFirst ? events.reverse() : events;
}

/** The parcel's weight in kilograms, as the summary gives it; anything else is left out. */
function weight(shipment: Record<string, unknown>): number | null {
  const value = text(shipment, 'weight', 20).replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const kilograms = Number(value);
  return kilograms > 0 && kilograms < 100_000 ? kilograms : null;
}

/** The lookup's own failure, which the WordPress side wraps: a request that never reached the tracking service, or its error. */
function upstreamFailure(request: Record<string, unknown>): void {
  if (isRecord(request.errors)) throw new IndeterminateError(PROVIDER, 'Pandu Logistics could not reach its tracking service');
  const response = request.response;
  if (!isRecord(response)) invalid('Pandu Logistics returned a lookup without its answer');
  // The tracking service's own status, which the page's reply carries.
  if (response.code !== 200) throw new IndeterminateError(PROVIDER, 'Pandu Logistics\' tracking service failed');
}

/**
 * The reply of the tracking page's `admin-ajax.php` lookup for one number. The
 * WordPress side asks Pandu's tracking service and returns its decoded answer
 * as `json`, its raw answer under `request`, and the page's rendering as
 * `html`. The service answers an unknown number with an empty body, which
 * leaves `json` null and the page says it is not found. A shipment is one
 * `detail` record, with the sender, the consignee, their cities, the postcode,
 * the contents and the receiver, none of which is kept, and its scans in
 * `track`, oldest first.
 */
export function parsePanduLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizePanduLogisticsNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'json')) invalid('Pandu Logistics returned an invalid envelope');
  const request = payload.request;
  if (!isRecord(request)) invalid('Pandu Logistics returned a lookup without its request');
  upstreamFailure(request);
  const html = typeof payload.html === 'string' ? payload.html : '';
  const data = payload.json;
  if (data === null) {
    const body = request.body;
    if (body !== '' && body !== null && body !== undefined) invalid('Pandu Logistics\' tracking service returned a reply that is not JSON');
    if (!NOT_FOUND.test(html)) invalid('Pandu Logistics returned an empty answer without its notice');
    throw new NotFoundError(PROVIDER);
  }
  if (!isRecord(data) || !Array.isArray(data.detail)) invalid('Pandu Logistics returned an answer without its shipment');
  if (!data.detail.length) {
    if (NOT_FOUND.test(html)) throw new NotFoundError(PROVIDER);
    invalid('Pandu Logistics returned an answer without its shipment');
  }
  if (data.detail.length > 1) throw new IndeterminateError(PROVIDER, 'Pandu Logistics listed several shipments for the number');
  const shipment: unknown = data.detail[0];
  if (!isRecord(shipment) || typeof shipment.awb !== 'string') invalid('Pandu Logistics returned a shipment without its number');
  if (normalizeTrackingNumber(shipment.awb).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Pandu Logistics answered for another shipment');

  // The summary's own status decides a delivery; its description is then the receiver's name.
  const summary = panduLogisticsMappedStage(text(shipment, 'status_delivery', 60));
  const names = [text(shipment, 'sender_name', 120), text(shipment, 'consignee_name', 120),
    ...(summary === 'delivered' ? [text(shipment, 'status_description', 120)] : [])];
  const events = history(data.track, namePatterns(names));
  if (!events.length && !summary) throw new NoHistoryError(PROVIDER);

  const newest = events[0];
  const scanned = events.find((event) => event.stage);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source ?? 'carrier_map';
  const kilograms = weight(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest?.description ?? text(shipment, 'status_delivery', 60),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
