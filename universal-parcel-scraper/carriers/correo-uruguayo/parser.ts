import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { correoUruguayoStage, summaryStage } from './status.js';

export const PROVIDER = 'Correo Uruguayo';
// A long history is a few kilobytes.
export const CORREO_URUGUAYO_MAX_BYTES = 256 * 1024;

const MAX_SCANS = 500;
const CLOCK = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;

/**
 * Correo Uruguayo's tracker takes S10 item codes only: its own, ending UY,
 * and those of the posts that send mail to Uruguay. The code needs a valid
 * check digit.
 */
export function normalizeCorreoUruguayoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correo Uruguayo tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Correo Uruguayo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's numeric `codigoevento`, kept for review. */
function code(row: Record<string, unknown>): string {
  const value = row.codigoevento;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return value.trim();
  throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an invalid scan code');
}

/**
 * A scan's `fecha`, "19/08/2026 22:27": a wall clock to the minute, with no
 * zone, as the page shows it.
 */
function wallClock(value: string): string {
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = CLOCK.test(value) ? DateTime.fromFormat(value, 'dd/MM/yyyy HH:mm', { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat('dd/MM/yyyy HH:mm') !== value) {
    throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The office, as "Planta Logistica Postal, ,PANDO": its parts, without the empty ones. */
function office(value: string): string {
  return value.split(',').map((part) => part.trim()).filter(Boolean).join(', ');
}

/**
 * A scan's wording up to its first colon. A delivery or a delivery attempt,
 * "ENTREGADO A: …" or "INTENTO DE ENTREGA: …", goes on with recipient
 * details; the delivery keeps "ENTREGADO".
 */
function wording(value: string): string {
  const colon = value.indexOf(':');
  return colon < 0 ? clean(value, 200) : clean(value.slice(0, colon), 200).replace(/\s+A$/i, '');
}

/** A scan's clock, office, wording and code; its office code, source, operator, round and delivery note are left out. */
function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an invalid scan');
  const description = wording(text(row, 'evento', 2_000));
  if (!description) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned a scan without wording');
  const local = wallClock(text(row, 'fecha', 32));
  const location = office(text(row, 'ubicacion', 160));
  const provider = code(row);
  const staged = correoUruguayoStage(description);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The item's codes: `idNacional`, the post's own, and `idInternacional`, the one it came with. */
function codes(item: Record<string, unknown>): { national: string; international: string } {
  const read = (key: string): string => {
    const value = item[key];
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Correo Uruguayo returned an invalid ${key}`);
    return normalizeTrackingNumber(clean(value, 64));
  };
  return { national: read('idNacional'), international: read('idInternacional') };
}

/**
 * The reply of the tracker's `GET /seguimientoEnvios/eventosweb` for one code:
 * an array with one entry, whose `estado` says whether the tracker found the
 * item. Its scans come newest first. The entry names the code, as
 * `idNacional`, `idInternacional` or both, except a not-found entry for
 * another post's code, which names none.
 */
export function parseCorreoUruguayo(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeCorreoUruguayoNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an invalid reply');
  if (!payload.length) throw new IndeterminateError(PROVIDER, 'Correo Uruguayo returned no entry for the code');
  if (payload.length !== 1) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned several items for one code');
  const item: unknown = payload[0];
  if (!isRecord(item) || typeof item.estado !== 'string') throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an item without its state');
  const { national, international } = codes(item);
  if ((national || international) && national !== number && international !== number) {
    throw new SchemaError(PROVIDER, 'Correo Uruguayo answered for a different item');
  }
  const state = item.estado.trim();
  if (state === 'NOT_FOUND') throw new NotFoundError(PROVIDER);
  if (!national && !international) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an item without its code');
  // A code ending UY whose service letters the post does not use.
  if (state === 'INVALID_PRODUCT') throw new InvalidInputError(PROVIDER, 'Correo Uruguayo does not issue this service code', { reason: 'wrong_number' });
  // The page shows only the day of the last scan of an item whose records went to the archive.
  if (state === 'FILED') throw new IndeterminateError(PROVIDER, 'Correo Uruguayo has archived the item’s history', { reason: 'history_expired' });
  if (state !== 'SUCCESS') throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an unexpected item state');

  const rows = item.eventos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an item with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Correo Uruguayo returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.forEach((row) => {
    const event = scanOf(row);
    // A scan the reply lists twice is kept once, as is a delivery the office and
    // the international exchange both report in the same minute under their own codes.
    const identity = JSON.stringify([event.local_time, event.description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock, as the page lists them; scans in the same minute keep the reply's order.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => right.local_time! > left.local_time! ? 1 : right.local_time! < left.local_time! ? -1 : 0);

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const scanned = current?.stage as Stage | undefined;
  // The page's progress bar ends at a delivery whatever the last scan says.
  const summary = summaryStage(text(item, 'codigoEtapaEntrega', 40));
  const stage = summary === 'delivered' && scanned !== 'delivered' && scanned !== 'returned' ? summary : scanned ?? summary;
  const source = current && stage === scanned ? current.stage_source : 'carrier_map';
  // The other code the item carries: the one it came with, or the one the post gave it.
  const other = number === national ? international : national;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(other && isValidS10TrackingNumber(other)
      ? number === national ? { international_tracking_number: other } : { canonical_tracking_number: other } : {}),
    events,
  };
}
