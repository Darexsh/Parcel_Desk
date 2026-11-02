import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GUATEX_CREDITED, guatexStage } from './status.js';

export const PROVIDER = 'Guatex';
// A guía's reply is a few kilobytes, and each row adds about two hundred bytes.
export const GUATEX_MAX_BYTES = 256 * 1024;
// The lookup's codes: "Consulta exitosa", and "El número de guía no existe" for a guía it does not know.
const FOUND = '200';
const MISSING = '204';
const MISSING_ANSWER = /^el n[uú]mero de gu[ií]a no existe\.?$/i;
// Up to fifteen letters and digits, as the tracker's own field takes.
const NUMBER = /^[A-Z0-9]{4,15}$/;
// Guatex serves Guatemala, which keeps UTC-6 all year.
const ZONE = 'America/Guatemala';
// A row's day and clock, as "05/03/2026" and "14:20".
const DAY = /^\d{2}\/\d{2}\/\d{4}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const CODE = /^[A-Z]{1,3}$/;
const POSITION = /^\d{1,4}$/;
// The summary's status for a guía the tracker shows as received.
const DELIVERED = 'entregado';
// A run of eight or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){7,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Guatex guía: up to fifteen letters and digits. Anything else is not one its tracker takes. */
export function normalizeGuatexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Guatex guías are up to fifteen letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Guatex returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Whether a field names the guía asked; a field without one says nothing. */
function names(record: Record<string, unknown>, number: string): boolean {
  const named = text(record, 'noguia', 64);
  return !named || normalizeTrackingNumber(named) === number;
}

type Clock = { time: string } | { local_time: string };

/**
 * A day and clock, read in Guatemala and read back unchanged, as an instant to
 * the minute. A day without a clock stays a day.
 */
function readClock(day: string, clock: string, what: string): Clock {
  if (DAY.test(day) && (!clock || CLOCK.test(clock))) {
    const format = clock ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy';
    const local = clock ? `${day} ${clock}` : day;
    const wall = firstOccurrence(DateTime.fromFormat(local, format, { zone: ZONE }));
    // Luxon rolls an impossible day over; only a clock that reads back unchanged is kept.
    if (wall.isValid && wall.toFormat(format) === local) {
      return clock ? { time: wall.toUTC().toISO({ suppressMilliseconds: true }) } : { local_time: wall.toFormat('yyyy-MM-dd') };
    }
  }
  throw new SchemaError(PROVIDER, `Guatex returned an invalid ${what}`);
}

/** A row's wording without phone numbers. */
function wordingOf(value: string): string {
  return clean(value.replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Row { code: string; description: string; clock: Clock; position: number }

/**
 * One row of `tracking`: its day and clock, its wording in `movimiento` (also
 * in `estado`), its one- or two-letter code in `descripcion` and the guía it
 * belongs to. Its route is not read.
 */
function projectRow(row: unknown, index: number, number: string): Row | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Guatex returned an invalid row');
  if (!names(row, number)) throw new IndeterminateError(PROVIDER, 'Guatex answered for another guía');
  const code = text(row, 'descripcion', 8).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Guatex returned an invalid status code');
  // The amount credited to the sender moves nothing; the page leaves it out too.
  if (code === GUATEX_CREDITED) return null;
  const description = wordingOf(text(row, 'movimiento') || text(row, 'estado'));
  if (!description) throw new SchemaError(PROVIDER, 'Guatex returned a row without its wording');
  const clock = readClock(text(row, 'fecha', 16), text(row, 'hora', 16), 'row date');
  const pos = text(row, 'pos', 8);
  if (pos && !POSITION.test(pos)) throw new SchemaError(PROVIDER, 'Guatex returned an invalid row position');
  return { code, description, clock, position: pos ? Number(pos) : index + 1 };
}

/** The rows, newest first as `pos` numbers them, without repeats. */
function rowsOf(value: unknown, number: string): Row[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, 'Guatex returned invalid rows');
  if (value.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Guatex returned an oversized history');
  const seen = new Set<string>();
  return value.map((row, index) => projectRow(row, index, number))
    .filter((row): row is Row => row !== null)
    .sort((left, right) => left.position - right.position)
    .filter((row) => {
      const key = JSON.stringify([row.clock, row.code, row.description]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The reply of `POST /Guatex/Login/ObtengoTrackingGuia` with `noguia`, the
 * lookup of the tracker page at servicios.guatex.gt. A guía it knows is code
 * 200 with a summary and its rows, newest first; one it does not know is code
 * 204, "El número de guía no existe". Both name the guía, which must be the
 * one asked. Only the number, the rows' clocks, wordings and codes, and the
 * summary's status and delivery time are read; the reply's other details are not.
 */
export function parseGuatex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGuatexNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Guatex returned an invalid reply');
  const code = cleanScalar(payload.codigo, 8);
  if (!code) throw new SchemaError(PROVIDER, 'Guatex returned a reply without its code');
  if (!names(payload, number)) throw new IndeterminateError(PROVIDER, 'Guatex answered for another guía');
  if (code === MISSING && MISSING_ANSWER.test(text(payload, 'respuesta', 120))) throw new NotFoundError(PROVIDER);
  // The page reads any other code as a missing guía; only its own answer for one is.
  if (code !== FOUND) throw new IndeterminateError(PROVIDER, 'Guatex did not complete the lookup');
  if (!text(payload, 'noguia', 64)) throw new SchemaError(PROVIDER, 'Guatex returned a guía without its number');
  const summary = payload.informacionTracking;
  if (!isRecord(summary)) throw new SchemaError(PROVIDER, 'Guatex returned a guía without its summary');
  if (!names(summary, number)) throw new IndeterminateError(PROVIDER, 'Guatex answered for another guía');

  const rows = rowsOf(payload.tracking, number);
  const events: CarrierEvent[] = rows.map((row, index) => {
    // The row after a departure is the newer one before it.
    const staged = guatexStage(row.code, row.description, rows[index - 1]?.code);
    return {
      ...row.clock,
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      ...(row.code ? { provider_code: row.code } : {}),
    };
  });

  // The summary's status, and the day and clock the page shows as the time the guía was received.
  const status = text(summary, 'estado', 60);
  const received = normalizeStatusWording(status) === DELIVERED;
  const day = received ? text(summary, 'fecha', 16) : '';
  const clock = day ? readClock(day, text(summary, 'hora', 16), 'delivery date') : undefined;
  const deliveredOn = clock && 'time' in clock ? clock.time : undefined;

  if (!events.length) {
    if (!received) throw new NoHistoryError(PROVIDER);
    return {
      status: 'delivered',
      current_stage: 'delivered',
      current_stage_source: 'carrier_map',
      last_status_text: status,
      last_update: deliveredOn ?? null,
      expected_delivery: null,
      ...(deliveredOn ? { delivered_at: deliveredOn } : {}),
      timezone: ZONE,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  // A summary that says received stands for a delivery the rows can lack, unless they hold a return.
  const returning = events.some((event) => event.stage === 'returned' || event.stage === 'exception');
  const settled = received && current?.stage !== 'delivered' && current?.stage !== 'returned' && !returning;
  const stage = (settled ? 'delivered' : current?.stage) as Stage | undefined;
  const source = settled ? 'carrier_map' : current?.stage_source;
  // The courier's delivery is the handover, on the summary's clock; the same delivery
  // recorded at the agency afterwards is no later one. Without the summary's clock,
  // the oldest delivery of the newest run stands for it.
  const end = events.findIndex((event) => event.stage !== 'delivered');
  const run = end === -1 ? events : events.slice(0, end);
  const delivered = stage === 'delivered' ? deliveredOn ?? run.filter((event) => event.time).at(-1)?.time : undefined;
  const latest = [newest.time, deliveredOn].filter((time): time is string => Boolean(time)).sort().at(-1);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: settled ? status : newest.description!,
    last_update: latest ?? null,
    ...(!newest.time && newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
