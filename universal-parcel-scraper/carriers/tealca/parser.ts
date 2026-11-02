import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tealcaStage, tealcaSummary } from './status.js';

export const PROVIDER = 'Tealca';
// A long history is a few kilobytes.
export const TEALCA_MAX_BYTES = 256 * 1024;
// Guías are seven or eight digits; letters make the lookup fail.
const NUMBER = /^\d{6,12}$/;
// The lookup's message for a number it does not know, which the page shows as it comes.
const ABSENT = /^n[uú]mero de shipment no existe$/i;
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP])M$/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Tealca guía, six to twelve digits; anything else is not one Tealca issues. */
export function normalizeTealcaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Tealca guías are digits');
  return number;
}

// The requested number the creation scan repeats ("Guía creada con el número …").
const OWN_NUMBER = /\s*\bcon el n[uú]mero\s+[A-Z\d-]*/gi;
// Who took the parcel, after the delivery's wording ("Guía entregada a … - …").
const RECEIVER = /\b(entregad[ao]s?|recibid[ao]s?|retirad[ao]s?)\s+(?:a|al|por)\b[\s\S]*$/i;
// A run of six or more digits, with spaces, dots or hyphens between them and an
// optional V-, E-, J-, G- or P- in front, as ID card and phone numbers are written.
const ID_OR_PHONE = /(?<![A-Z\d])(?:[VEJGP]\s?-?\s?)?\+?\d(?:[\s.-]?\d){5,}(?![A-Z\d])/gi;

/**
 * A scan's wording as the page heads it, without the guía's own number, the
 * person a delivery names or ID card and phone numbers. Stores and platforms
 * stay: `Recepción en tienda destino 2002 - Sample Store`.
 */
export function tealcaWording(raw: unknown): string {
  const text = clean(raw, 1_000).replace(OWN_NUMBER, '').replace(RECEIVER, '$1').replace(ID_OR_PHONE, '');
  return clean(clean(text).replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's `date`, `M/D/YYYY h:mm:ss AM`. The page shows it as it comes and
 * names no zone, so it stays a wall clock.
 */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const hour = match ? Number(match[4]) : 0;
  if (!match || hour < 1 || hour > 12) throw new SchemaError(PROVIDER, 'Tealca returned an invalid scan time');
  const hours = (hour % 12) + (match[7]!.toUpperCase() === 'P' ? 12 : 0);
  const local = `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}T${String(hours).padStart(2, '0')}:${match[5]}:${match[6]}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Tealca returned an invalid scan time');
  }
  return local;
}

/** A shipment's number as a whole: a string, or an exact nonnegative integer. */
function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value.trim()) throw new SchemaError(PROVIDER, 'Tealca returned a shipment without its number');
  return normalizeTrackingNumber(value.slice(0, 64));
}

/** The shipment's scans, newest first; the same scan at the same clock once. */
function history(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.tracking ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Tealca returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Tealca returned an oversized history');
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; index: number }[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Tealca returned an invalid scan');
    if (typeof row.status !== 'string') throw new SchemaError(PROVIDER, 'Tealca returned a scan without wording');
    const description = tealcaWording(row.status);
    if (!description) throw new SchemaError(PROVIDER, 'Tealca returned a scan without wording');
    const local = wallClock(row.date);
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = tealcaStage(description);
    scans.push({ index, event: {
      local_time: local,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // The reply lists scans oldest first; scans at one clock keep the order they were written in.
  return scans.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.index - a.index)
    .map(({ event }) => event);
}

/**
 * The reply of the tracking page's lookup, `POST /wp-json/tealca-rastreo/v1/rastreo`.
 * It answers `result: false` with a message for a number it does not know,
 * and a list of shipments otherwise; the one whose `shipment` is the number
 * asked is kept. Its origin store and each scan's `city` and `state`, which
 * repeat that store's, are not kept, nor is the scan's `description`.
 */
export function parseTealca(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTealcaNumber(raw);
  if (!isRecord(payload) || typeof payload.result !== 'boolean' || !Array.isArray(payload.data)) {
    throw new SchemaError(PROVIDER, 'Tealca returned an invalid envelope');
  }
  if (!payload.result) {
    if (ABSENT.test(clean(payload.Message, 200))) throw new NotFoundError(PROVIDER);
    // A failure of the lookup itself, such as its crash on letters.
    throw new IndeterminateError(PROVIDER, 'Tealca did not complete the lookup');
  }
  if (payload.data.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Tealca returned too many shipments');
  const shipments = payload.data.filter((item): item is Record<string, unknown> => {
    if (!isRecord(item)) throw new SchemaError(PROVIDER, 'Tealca returned an invalid shipment');
    return identifier(item.shipment) === number;
  });
  if (shipments.length !== 1) {
    throw new IndeterminateError(PROVIDER, shipments.length ? 'Tealca returned several shipments under the number' : 'Tealca answered for another shipment');
  }
  const shipment = shipments[0]!;
  const events = history(shipment);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = tealcaSummary(cleanScalar(shipment.status, 8))?.stage;
  // The summary decides a delivery; scans decide the rest, as code 2 covers the whole journey.
  const stage = (summary === 'delivered' ? summary : scanned?.stage ?? summary) as Stage | undefined;
  const source = stage === scanned?.stage ? scanned?.stage_source : 'carrier_map';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
