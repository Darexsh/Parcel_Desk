import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { STARKEN_WAITING, starkenMappedStage, starkenStage } from './status.js';

export const PROVIDER = 'Starken';
// A long history is a few tens of kilobytes, sealed and in base64.
export const STARKEN_MAX_BYTES = 512 * 1024;
// The tracking page's own check: digits only, nine at most, not zero.
const NUMBER = /^\d{1,9}$/;
// A scan's wall clock, day first.
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}:\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}T/;
const NOT_FOUND = /no se encuen\w* datos/i;
const INVALID = /orden de flete invalida/i;
const MAX_PACKAGES = 50;
const MAX_ROWS = 2_000;
const MAX_EVENTS = 100;

/** An order of freight number as the tracking page sends it, without leading zeros; anything else is not one Starken issues. */
export function normalizeStarkenNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).replace(/^0+(?=\d)/, '') : '';
  if (!NUMBER.test(number) || number === '0') throw new InvalidInputError(PROVIDER, 'Starken order numbers are up to nine digits');
  return number;
}

/** An order number in the reply, a number or digits; anything else is a changed reply. */
function orderNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,18}$/.test(value.trim())) return value.trim().replace(/^0+(?=\d)/, '');
  throw new SchemaError(PROVIDER, 'Starken returned an order without its number');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Starken returned an invalid ${key}`);
  return clean(value, maxLength);
}

function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `Starken returned an invalid ${key}`);
  if (value.length > max) throw new SchemaError(PROVIDER, 'Starken returned an oversized history');
  return value;
}

/**
 * A scan's clock, `DD-MM-YYYY HH:mm:ss`. The reply names no zone, and Chile's
 * regions do not share one all year, so the wall clock stays local.
 */
function scanClock(value: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}` : '';
  // Parsing in UTC checks the calendar digits only; luxon rolls 24:00 over to the next day.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Starken returned an invalid scan time');
  }
  return local;
}

function projectScan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Starken returned an invalid scan');
  const code = text(row, 'macro_estado', 40).toUpperCase();
  // The page shows `estado_interno`; the process state stands in when it is empty.
  const description = text(row, 'estado_interno') || text(row, 'estado');
  if (!description) throw new SchemaError(PROVIDER, 'Starken returned a scan without wording');
  const local = scanClock(text(row, 'senfecha', 32));
  const staged = starkenStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description]), event };
}

/** Every package's scans, newest first, each scan once. */
function scans(data: Record<string, unknown>): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let rows = 0;
  for (const pack of list(data, 'encargos', MAX_PACKAGES)) {
    if (!isRecord(pack)) throw new SchemaError(PROVIDER, 'Starken returned an invalid package');
    for (const day of list(pack, 'encargo', MAX_ROWS)) {
      if (!isRecord(day)) throw new SchemaError(PROVIDER, 'Starken returned an invalid day of scans');
      for (const row of list(day, 'pinchazos', MAX_ROWS)) {
        if ((rows += 1) > MAX_ROWS) throw new SchemaError(PROVIDER, 'Starken returned an oversized history');
        const scan = projectScan(row);
        if (seen.has(scan.key)) continue;
        seen.add(scan.key);
        events.push(scan.event);
      }
    }
  }
  // The reply lists each day and its scans oldest first; a stable sort keeps a second's scans in order.
  const newestFirst = events.reverse().sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  // A run of waiting notes keeps its newest.
  const waiting = (event: CarrierEvent | undefined) => normalizeStatusWording(event?.description ?? '') === STARKEN_WAITING;
  return newestFirst.filter((event, index) => !waiting(event) || !waiting(newestFirst[index - 1]));
}

/** The day the page gives as the estimate: the date part of `fechaEntEstimada`, as the page reads it. */
function estimate(data: Record<string, unknown>): string | null {
  const value = text(data, 'fechaEntEstimada', 40);
  if (!DAY.test(value)) return null;
  const day = value.slice(0, 10);
  return DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/**
 * How the order was closed without a delivery, or nothing: its own closing
 * code, else the page's closure with an exception, else a claim. An open
 * claim on a parcel still moving closes nothing.
 */
function closure(data: Record<string, unknown>): string | null {
  if (data.isTermino !== true && data.cerradoExc !== true) return null;
  const own = data.isTermino === true ? text(data, 'tipoTermino', 40).toUpperCase() : '';
  if (own) return own;
  if (data.cerradoExc === true) return 'CERRADO CON EXCEPCION';
  return Array.isArray(data.reclamos) && data.reclamos.length ? 'RECLAMO' : '';
}

/**
 * Starken's answer for a number it has no order under: HTTP 404 with
 * `{"status":404,"error":"No se encuentan datos para la of consultada."}`.
 * It calls a number it cannot read an invalid order. Any other 404 is not
 * about the parcel.
 */
export function starkenMissing(payload: unknown): never {
  const message = isRecord(payload) ? `${clean(payload.error, 200)} ${clean(payload.message, 200)}` : '';
  if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER);
  if (INVALID.test(message)) throw new InvalidInputError(PROVIDER, 'Starken does not take this order number', { reason: 'wrong_number' });
  throw new SchemaError(PROVIDER, 'Starken returned an unexpected missing-order reply');
}

/**
 * The opened reply of the tracking page's `historialClOfs` for one order: its
 * summary and, per package, its days of scans. It must name the order asked,
 * both as the order consulted and as the order found.
 */
export function parseStarken(payload: unknown, raw: string): CarrierResult {
  const number = normalizeStarkenNumber(raw);
  if (Array.isArray(payload) && !payload.length) throw new IndeterminateError(PROVIDER, 'Starken returned an empty answer');
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Starken returned an invalid order');
  if (orderNumber(payload.ofConsultada) !== number || orderNumber(payload.odflCodigo) !== number) {
    throw new IndeterminateError(PROVIDER, 'Starken answered for another order');
  }
  const events = scans(payload);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const scannedStage = scanned?.stage as Stage | undefined;
  const ended = scannedStage === 'delivered' || scannedStage === 'returned';
  const closed = ended ? null : closure(payload);
  const stage = closed === null ? scannedStage : starkenMappedStage(closed) ?? 'exception';
  const source = closed === null ? scanned?.stage_source : 'carrier_map';
  const expected = ended || closed !== null ? null : estimate(payload);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    ...(closed ? { provider_code: closed } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
