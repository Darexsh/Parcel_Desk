import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pdqStage, pdqSummaryKey, pdqSummaryStage } from './status.js';

export const PROVIDER = 'PDQ';
// A delivered shipment's reply is about one kilobyte.
export const PDQ_MAX_BYTES = 256 * 1024;
// Guide numbers are twelve digits: the page tells a visitor whose input has
// another shape to search by guide number instead.
const NUMBER = /^\d{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A PDQ guide number; anything else is not one PDQ issues. */
export function normalizePdqNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PDQ guide numbers are twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PDQ returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional object field; anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `PDQ returned an invalid ${key}`);
  return value;
}

/** A calendar day, `YYYY-MM-DD`, that reads back unchanged. */
function day(value: string): boolean {
  return DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).toISODate() === value;
}

/**
 * A scan's clock: `fecha` and `hora`, a wall clock to the minute. The reply
 * names no zone and Chile's regions do not share one all year, so the clock
 * stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = text(row, 'fecha', 16);
  const time = text(row, 'hora', 16);
  const local = `${date}T${time}:00`;
  // Parsing in UTC checks the calendar digits only; luxon rolls 24:00 over to the next day.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!day(date) || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'PDQ returned an invalid scan time');
  }
  return local;
}

/** The name of the branch a scan or a notice names, or nothing. */
function branch(row: Record<string, unknown>): string {
  const office = record(row, 'delegacion');
  return office ? text(office, 'nombre', 120) : '';
}

/**
 * One scan: its wording, code, clock and branch. Its `detalle`, which on a
 * delivery names who took the parcel and the driver, is not kept.
 */
function projectScan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PDQ returned an invalid scan');
  const description = text(row, 'descripcion');
  if (!description) throw new SchemaError(PROVIDER, 'PDQ returned a scan without wording');
  const code = text(row, 'codigo', 16).toUpperCase();
  const local = scanClock(row);
  const location = branch(row);
  const staged = pdqStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** Every scan once, newest first as the page lists them. */
function scans(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.eventos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PDQ returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PDQ returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectScan(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  // An oldest-first list is turned round first, so scans of one minute keep the reply's order.
  if (events.length > 1 && String(events[0]!.local_time) < String(events.at(-1)!.local_time)) events.reverse();
  return events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
}

/**
 * The branch the parcel waits at, from the page's notice to collect it at a
 * PDQ office (`aviso.tipo` `retiro-oficina`), or nothing.
 */
function pickupOffice(shipment: Record<string, unknown>): string | null {
  const notice = record(shipment, 'aviso');
  if (!notice || text(notice, 'tipo', 40) !== 'retiro-oficina') return null;
  const name = branch(notice);
  return name ? `PDQ ${name}` : '';
}

/**
 * The reply's answer when it found no shipment for the number: `motivo` says
 * why. Only `no-existe` is PDQ's word that it has no such guide. A number that
 * matched shipper references (`ambiguo`, `multiple`) asks for the recipient's
 * details or lists guide numbers; nothing of it is kept.
 */
function unfound(payload: Record<string, unknown>): never {
  const reason = typeof payload.motivo === 'string' ? payload.motivo : '';
  if (reason === 'no-existe') throw new NotFoundError(PROVIDER);
  if (reason === 'ambiguo' || reason === 'multiple') {
    throw new IndeterminateError(PROVIDER, 'PDQ matched the number as a shipper reference, not a guide');
  }
  if (reason === 'input-invalido') throw new InvalidInputError(PROVIDER, 'PDQ does not take this guide number', { reason: 'wrong_number' });
  if (reason === 'no-autorizado') throw new ChallengeError(PROVIDER, 'PDQ refused the lookup');
  if (reason === 'error') throw new IndeterminateError(PROVIDER, 'PDQ did not complete the lookup');
  throw new SchemaError(PROVIDER, 'PDQ returned an unexpected answer');
}

/**
 * The reply of the tracking page's `/api/tracking?q={number}`. A found
 * shipment is `{"encontrado":true,"expedicion":{…}}` and must carry the guide
 * number asked; anything else is `{"encontrado":false,"motivo":…}`.
 */
export function parsePdq(payload: unknown, raw: string): CarrierResult {
  const number = normalizePdqNumber(raw);
  if (!isRecord(payload) || typeof payload.encontrado !== 'boolean') throw new SchemaError(PROVIDER, 'PDQ returned an invalid envelope');
  if (!payload.encontrado) unfound(payload);
  const shipment = record(payload, 'expedicion');
  if (!shipment || typeof shipment.numero !== 'string') throw new SchemaError(PROVIDER, 'PDQ returned a shipment without its number');
  if (clean(shipment.numero, 64) !== number) throw new IndeterminateError(PROVIDER, 'PDQ answered for another shipment');

  const events = scans(shipment);
  const estado = text(shipment, 'estado', 60);
  const summary = pdqSummaryStage(estado);
  const office = pickupOffice(shipment);
  const delivered = summary === 'delivered';
  const newest = events[0];
  const scanned = events.find((event) => event.stage);
  // The page's word decides a delivery, and a parcel it asks the recipient to
  // collect at a branch waits there; otherwise the newest staged scan stands.
  const stage: Stage | undefined = delivered ? 'delivered' : office !== null ? 'ready_for_pickup'
    : (scanned?.stage as Stage | undefined) ?? summary;
  const source = stage && stage === scanned?.stage ? scanned.stage_source ?? 'carrier_map' : 'carrier_map';
  if (!events.length && !stage) throw new NoHistoryError(PROVIDER);
  const target = text(shipment, 'fechaObjetivo', 16);
  const expected = stage === 'delivered' || stage === 'ready_for_pickup' || !day(target) ? null : target;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest?.description ?? estado,
    ...(newest ? {} : { provider_code: pdqSummaryKey(estado), summary_only: true }),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(office ? { pickup_point: office } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
