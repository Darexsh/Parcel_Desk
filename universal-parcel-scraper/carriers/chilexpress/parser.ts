import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chilexpressStage } from './status.js';

export const PROVIDER = 'Chilexpress';
// A long history is a few tens of kilobytes.
export const CHILEXPRESS_MAX_BYTES = 512 * 1024;
// The help centre's own check of a transport order number.
const NUMBER = /^\d{10,12}$/;
const SCAN_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The promised day, in the service's US form with a time it always puts at the end of the day.
const ESTIMATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: \d{1,2}:\d{2}:\d{2} [AP]M)?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A transport order number for Chilexpress's tracker; anything else is not one it issues. */
export function normalizeChilexpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Chilexpress transport order numbers are ten to twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Chilexpress returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The order number a scan names, as the service reads it: an integer, so without leading zeros. */
function orderNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  throw new SchemaError(PROVIDER, 'Chilexpress returned a scan without its order number');
}

/**
 * A scan's clock: the reply's wall clock, without a zone, to the
 * millisecond, which is dropped. The reply names no zone, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const local = SCAN_CLOCK.exec(text(row, 'fec_track', 40))?.[1];
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Chilexpress returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } | null {
  const type = row.cod_tipo_evento;
  if (typeof type !== 'number' || !Number.isSafeInteger(type)) throw new SchemaError(PROVIDER, 'Chilexpress returned a scan without its event type');
  const code = String(type);
  const description = text(row, 'gls_tracking');
  const local = scanClock(row);
  // The page leaves a scan without wording out of its list.
  if (!description) return null;
  // The facility that scanned, or the branch holding the parcel for collection.
  const location = text(row, 'gls_Destino', 120);
  const stage = chilexpressStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The day the service promises, or null when the reply has none. */
function estimate(order: Record<string, unknown> | null): string | null {
  const match = order ? ESTIMATE.exec(text(order, 'gls_tiempo_estimado', 40)) : null;
  if (!match) return null;
  const day = DateTime.fromObject({ year: Number(match[3]), month: Number(match[1]), day: Number(match[2]) }, { zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

/** A positive measure from the order's summary; the reply puts 0 where it has none. */
function measure(order: Record<string, unknown> | null, key: string): number | null {
  const value = order?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000 ? value : null;
}

/**
 * The reply of the help centre's `gettracking` for one transport order: its
 * summary (`DatosOT`), its scans (`ListTracking`) and the outcome
 * (`Respuesta`). An order the service does not know comes back with HTTP 200,
 * `resultado: false`, no message and no scans, which the page reports as not
 * found. Every scan must name the order asked.
 */
export function parseChilexpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChilexpressNumber(raw);
  const outcome = isRecord(payload) ? payload.Respuesta : undefined;
  if (!isRecord(payload) || !isRecord(outcome) || typeof outcome.resultado !== 'boolean') {
    throw new SchemaError(PROVIDER, 'Chilexpress returned an invalid envelope');
  }
  const rows = payload.ListTracking ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Chilexpress returned an order with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Chilexpress returned an oversized history');
  const order = payload.DatosOT ?? null;
  if (order !== null && !isRecord(order)) throw new SchemaError(PROVIDER, 'Chilexpress returned an invalid order summary');
  if (!outcome.resultado) {
    // Only the empty answer is the page's "no data for this transport order"; a message is the service failing.
    if (!rows.length && !text(outcome, 'respuesta')) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Chilexpress did not complete the lookup');
  }

  const asked = number.replace(/^0+(?=\d)/, '');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chilexpress returned an invalid scan');
    if (orderNumber(row.nro_ot) !== asked) throw new IndeterminateError(PROVIDER, 'Chilexpress answered for another transport order');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const stage = newestFirst.find((event) => event.stage)?.stage as Stage | undefined;
  const service = order ? text(order, 'gls_servicio', 80) : '';
  const weight = measure(order, 'peso');
  const [length, width, height] = ['largo', 'ancho', 'alto'].map((key) => measure(order, key));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(order),
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(length && width && height ? { dimensions_text: `${length} × ${width} × ${height} cm` } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
