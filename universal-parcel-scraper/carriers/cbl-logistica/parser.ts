import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cblScanStage, cblSituation } from './status.js';

export const PROVIDER = 'CBL Logística';
// A long history is a few kilobytes.
export const CBL_MAX_BYTES = 512 * 1024;
// CBL's shipment numbers are digits; the tracker refuses a locator shorter than eight characters.
const NUMBER = /^\d{8,20}$/;
// The reply's only error for a locator it does not know.
const ABSENT = 'No hay datos';
// Its error for a locator shorter than eight characters.
const TOO_SHORT = 'Longitud incorrecta';
// A clock as the reply's serializer writes one without a zone, or as the page shows one.
const ISO_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$/;
const PAGE_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A CBL shipment number, eight to twenty digits; anything else is not one it issues. */
export function normalizeCblNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CBL shipment numbers are eight to twenty digits');
  return number;
}

/** The descriptions of one error list of the envelope. */
function errors(payload: Record<string, unknown>, key: string): string[] {
  const list = payload[key];
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list) || list.some((row) => !isRecord(row))) throw new SchemaError(PROVIDER, 'CBL returned an invalid error list');
  return (list as Record<string, unknown>[]).map((row) => clean(row.Description, 200));
}

// A Spanish or Portuguese phone number, nine digits with or without the country code,
// spaces, dots or hyphens; an email address; a Spanish ID number.
const PHONE = /(?<![A-Z\d])(?:(?:\+|00)?3(?:4|51)[\s.-]?)?[2-9](?:[\s.-]?\d){8}(?![A-Z\d])/gi;
const EMAIL = /\S+@\S+\.\S+/g;
const NATIONAL_ID = /\b(?:DNI|NIF|NIE)\b\s*:?\s*[A-Z\d-]*/gi;

/** A scan's wording without phone numbers, email addresses or IDs. */
export function cblWording(raw: unknown): string {
  return clean(clean(raw, 1_000).replace(EMAIL, '').replace(NATIONAL_ID, '').replace(PHONE, '')
    .replace(/\s+([,.:;)])/g, '$1'), 300).replace(/^[\s,.:;-]+|[\s,:;-]+$/g, '');
}

/**
 * A scan's `Fecha`: the wall clock of a network that spans two time zones,
 * named by none, so it stays local.
 */
function wallClock(value: unknown): string {
  const raw = clean(value, 40);
  let local = '';
  const iso = ISO_CLOCK.exec(raw);
  const page = iso ? null : PAGE_CLOCK.exec(raw);
  if (iso) local = `${iso[1]}T${iso[2]}:${iso[3] ?? '00'}`;
  else if (page) local = `${page[3]}-${page[2]}-${page[1]}T${page[4]!.padStart(2, '0')}:${page[5]}:${page[6] ?? '00'}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'CBL returned an invalid scan time');
  }
  return local;
}

/** The rows of `eventos` or `incidencias`, which the page reads as lists. */
function rows(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const list = data[key];
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, `CBL returned a shipment without its ${key}`);
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CBL returned an oversized history');
  if (list.some((row) => !isRecord(row))) throw new SchemaError(PROVIDER, 'CBL returned an invalid scan');
  return list as Record<string, unknown>[];
}

/**
 * A scan: its clock and its description. The comment beside it is free text
 * that can name people, and is not kept.
 */
function scanOf(row: Record<string, unknown>, incident: boolean): CarrierEvent | null {
  if (row.Descripcion !== undefined && row.Descripcion !== null && typeof row.Descripcion !== 'string') {
    throw new SchemaError(PROVIDER, 'CBL returned an invalid scan description');
  }
  const local = wallClock(row.Fecha);
  // The page shows a row without wording as an empty line; it says nothing.
  const description = cblWording(row.Descripcion);
  if (!description) return null;
  const staged = cblScanStage(description, incident);
  return { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** Whether the shipment's number is the whole number asked. */
function sameNumber(value: unknown, number: string): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && String(value) === number;
  return typeof value === 'string' && value.length <= 64 && normalizeTrackingNumber(value) === number;
}

/**
 * The reply of the locator page's `/api/public/PublicEnvios/Get/{number}`.
 * An unknown locator is `success: false` with the server error "No hay
 * datos". A shipment's `datos_expedicion` must name the number asked as
 * `NENVIO`; its scans are `eventos` and its incidents `incidencias`.
 */
export function parseCbl(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCblNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'CBL returned an invalid envelope');
  if (!payload.success) {
    const server = errors(payload, 'ServerErrors');
    const client = errors(payload, 'ClientErrors');
    if (client.includes(TOO_SHORT)) throw new InvalidInputError(PROVIDER, 'CBL refused the locator\'s length', { reason: 'wrong_number' });
    if (server.length === 1 && server[0] === ABSENT && !client.length) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'CBL did not complete the lookup');
  }
  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.datos_expedicion)) throw new SchemaError(PROVIDER, 'CBL returned a shipment without its details');
  const shipment = data.datos_expedicion;
  const own = shipment.NENVIO;
  if ((typeof own !== 'string' && typeof own !== 'number') || own === '') {
    throw new SchemaError(PROVIDER, 'CBL returned a shipment without its number');
  }
  if (!sameNumber(own, number)) throw new IndeterminateError(PROVIDER, 'CBL answered for another shipment');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const [key, incident] of [['eventos', false], ['incidencias', true]] as const) {
    for (const row of rows(data, key)) {
      const event = scanOf(row, incident);
      if (!event) continue;
      const identity = JSON.stringify([event.local_time, event.description]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      events.push(event);
    }
  }
  // Newest first by wall clock; rows of one clock keep the reply's order.
  if (listsNewestFirst(events) === false) events.reverse();
  const ordered = events.sort((left, right) => String(right.local_time).localeCompare(String(left.local_time)));

  const code = cleanScalar(shipment.SITUACION_LOCALIZADOR, 16).toUpperCase();
  const flag = shipment.HAY_INCIDENCIA;
  const situation = cblSituation(code, flag === '1' || flag === 1);
  if (!ordered.length && !situation) throw new NoHistoryError(PROVIDER);
  const scanned = ordered.find((event) => event.stage);
  const stage = (situation?.stage ?? scanned?.stage) as Stage | undefined;
  const source = situation ? 'carrier_map' : scanned?.stage_source;
  const newest = ordered[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? situation!.label,
    ...(newest ? {} : { ...(code ? { provider_code: code } : {}), summary_only: true }),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    events: ordered.slice(0, MAX_EVENTS),
    ...(ordered.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
