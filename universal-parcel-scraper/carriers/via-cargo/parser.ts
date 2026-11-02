import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { viaCargoStage } from './status.js';

export const PROVIDER = 'Via Cargo';
// A history with dozens of customer requests is under twenty kilobytes.
export const VIA_CARGO_MAX_BYTES = 512 * 1024;
// Via Cargo's shipment numbers: a counter of twelve digits from 999000000000.
const NUMBER = /^999\d{9}$/;
// A wall clock to the minute.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
const ZONE = 'America/Argentina/Buenos_Aires';
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Via Cargo shipment number; anything else is not one it issues. */
export function normalizeViaCargoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Via Cargo numbers are twelve digits starting with 999');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Via Cargo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: the branch's wall clock to the minute, as `dd/MM/yyyy HH:mm`.
 * Via Cargo carries parcels only within Argentina, which has one zone without
 * daylight saving, and its intakes and deliveries fall in the country's
 * working hours, so the clock is read in Buenos Aires time.
 */
function scanTime(value: string): string {
  const match = CLOCK.exec(value);
  const wall = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00` : '';
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Via Cargo returned an invalid scan time');
  }
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

interface Scan { event: CarrierEvent; at: number }

/**
 * One event of `listaEventos`: its type, its wording, the branch and its
 * clock. `fechaEvento` is when it happened; `fechaAlta`, which the page shows,
 * is when it was entered, which can be hours later.
 */
function readEvent(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Via Cargo returned an invalid scan');
  const code = text(row, 'tipoEvento', 16).toUpperCase();
  const description = text(row, 'descripcion', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Via Cargo returned a scan without wording');
  const time = scanTime(text(row, 'fechaEvento', 32) || text(row, 'fechaAlta', 32));
  const location = text(row, 'deleNombre', 120);
  const staged = viaCargoStage(code, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: DateTime.fromISO(time).toMillis() };
}

/** The weight the page shows in kilograms; none when the reply has none. */
function weight(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const kilos = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof kilos !== 'number' || !Number.isFinite(kilos) || kilos < 0) throw new SchemaError(PROVIDER, 'Via Cargo returned an invalid weight');
  return kilos > 0 && kilos < 100_000 ? kilos : null;
}

/**
 * The reply of `/alerce/tracking` for one number: `ok` lists the shipments
 * found, `errores` the lookup's errors and `score` a reCAPTCHA score. The page
 * reports errors as a failed lookup, and an empty `ok` without errors as no
 * shipment for the number. Of the shipment, only its number, service, weight
 * and events are read; the sender's and the recipient's names, addresses,
 * phone numbers and ID numbers, who took the parcel and the customer requests
 * are not.
 */
export function parseViaCargo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeViaCargoNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.ok) || !Array.isArray(payload.errores)) {
    throw new SchemaError(PROVIDER, 'Via Cargo returned an invalid envelope');
  }
  if (payload.errores.length) throw new IndeterminateError(PROVIDER, 'Via Cargo could not complete the lookup');
  if (!payload.ok.length) {
    // The service leaves the score null: it does not check the page's token.
    // An empty reply with a score may be a refused token, not a missing shipment.
    if (payload.score !== null && payload.score !== undefined) throw new ChallengeError(PROVIDER, 'Via Cargo checked the lookup\'s reCAPTCHA');
    throw new NotFoundError(PROVIDER);
  }
  if (payload.ok.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Via Cargo returned too many shipments');
  const shipments = payload.ok.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.objeto) || typeof entry.objeto.numeroEnvio !== 'string') {
      throw new SchemaError(PROVIDER, 'Via Cargo returned a shipment without its number');
    }
    return entry.objeto;
  });
  const matches = shipments.filter((shipment) => clean(shipment.numeroEnvio, 64) === number);
  if (!matches.length) throw new IndeterminateError(PROVIDER, 'Via Cargo answered for another shipment');
  if (matches.length > 1) throw new IndeterminateError(PROVIDER, 'Via Cargo answered with several shipments for the number');
  const shipment = matches[0]!;

  const rows = shipment.listaEventos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Via Cargo returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Via Cargo returned an oversized history');
  const seen = new Set<string>();
  const scans = rows.map(readEvent).filter(({ event }) => {
    const identity = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // Newest first, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.at - a.at).map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The delivery is the first scan of the run of delivered scans the history ends with.
  const ended = events.findIndex((event) => event.stage && event.stage !== 'delivered');
  const delivery = stage === 'delivered'
    ? events.slice(0, ended < 0 ? undefined : ended).reverse().find((event) => event.stage === 'delivered') : undefined;
  const service = text(shipment, 'descripcionServicio', 80);
  const kilos = weight(shipment.kilos);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    ...(kilos !== null ? { weight_kg: kilos } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
