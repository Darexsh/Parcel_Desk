import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tufesaStage } from './status.js';

export const PROVIDER = 'TufesaPack';
// A long history is a few kilobytes; a delivery can carry a signature image.
export const TUFESA_MAX_BYTES = 2 * 1024 * 1024;
// The codes of four letters and six digits customers were given.
const CODE = /^[A-Z]{4}\d{6}$/;
// The shipment's own number, a sequence without leading zeros now at eight digits.
const SERIAL = /^[1-9]\d{6,7}$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}$/;
// The answer's own number for a lookup that found the shipment, and for a code it does not know.
const FOUND = 0;
const UNKNOWN = 165;
// The delivery block's number once the delivery is recorded.
const DELIVERY_RECORDED = 1;
// The delivery type of a shipment the recipient collects at the destination branch.
const COLLECTED = 'OCURRE';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for TufesaPack's tracker, in upper case; anything else is not one TufesaPack issues. */
export function normalizeTufesaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!CODE.test(number) && !SERIAL.test(number)) {
    throw new InvalidInputError(PROVIDER, 'TufesaPack numbers are four letters and six digits, or a seven- or eight-digit shipment number');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TufesaPack returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A required message number. */
function messageNumber(row: Record<string, unknown>): number {
  const value = row.msgnum;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SchemaError(PROVIDER, 'TufesaPack returned an invalid message number');
  return value;
}

// Who took the parcel, should a shown line ever name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\brecibid[oa]\s+por\b[\s\S]*$/i;

/**
 * A scan's wall clock, from `fechamov` as `dd/MM/yyyy` and `horamov` as
 * `HH:mm`. The reply names no zone, and Tufesa's routes cross several, so the
 * clock stays local.
 */
function wallClock(date: string, time: string): string {
  const day = DATE.exec(date);
  const local = day && CLOCK.test(time) ? `${day[3]}-${day[2]}-${day[1]}T${time}:00` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'TufesaPack returned an invalid scan time');
  }
  return local;
}

/** A place the reply writes, without its placeholder for none. */
function place(row: Record<string, unknown>): string {
  const value = text(row, 'UbicacionLegible', 120) || text(row, 'ubicacion', 120);
  return /^-*$/.test(value) ? '' : value;
}

/**
 * The reply of the tracking page's `commdatosenvio` lookup: an array holding
 * one shipment with its scans, oldest first, each in Tufesa's own words
 * (`movimiento`), its code (`mov`) and the wording the page shows
 * (`MensageCliente`). A code it does not know comes back as message 165, "the
 * code is not valid", with dashes in every field; the page reports an empty
 * array as not found too.
 * The reply must echo the number asked, and a shipment number must be the
 * shipment's own: the lookup also finds a shipment by another reference.
 */
export function parseTufesa(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTufesaNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'TufesaPack returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > 1) throw new IndeterminateError(PROVIDER, 'TufesaPack answered with several shipments');
  const shipment: unknown = payload[0];
  if (!isRecord(shipment) || typeof shipment.code !== 'string') throw new SchemaError(PROVIDER, 'TufesaPack returned a shipment without its number');
  if (clean(shipment.code, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'TufesaPack answered for another number');
  const answer = messageNumber(shipment);
  if (answer === UNKNOWN) throw new NotFoundError(PROVIDER);
  if (answer !== FOUND) throw new IndeterminateError(PROVIDER, 'TufesaPack did not complete the lookup');
  if (SERIAL.test(number) && text(shipment, 'Rastreo', 32) !== number) {
    throw new IndeterminateError(PROVIDER, 'TufesaPack answered for another shipment');
  }
  const rows = shipment.historial;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'TufesaPack returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TufesaPack returned an oversized history');
  const collected = text(shipment, 'TipoServicio', 40).toUpperCase() === COLLECTED;

  const scans: { local: string; event: CarrierEvent; key: string }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TufesaPack returned an invalid scan');
    // The page shows only lines with its own wording; the line naming the receiver has none.
    const description = text(row, 'MensageCliente', 200).replace(RECEIVER, '');
    if (!description) continue;
    const local = wallClock(text(row, 'fechamov', 16), text(row, 'horamov', 16));
    const code = text(row, 'mov', 8).toUpperCase();
    const location = place(row);
    const staged = tufesaStage(code, description, collected);
    scans.push({ local, key: JSON.stringify([local, code, description, location]), event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // Newest first; the stable sort keeps the reply's order, turned round, within a minute.
  for (const scan of scans.reverse().sort((left, right) => right.local.localeCompare(left.local))) {
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The page counts a parcel delivered once its delivery is recorded, whatever line comes last.
  const delivered = isRecord(shipment.entrega) && shipment.entrega.msgnum === DELIVERY_RECORDED;
  const stage = (delivered ? 'delivered' : scanned?.stage) as Stage | undefined;
  const source = delivered && scanned?.stage !== 'delivered' ? 'carrier_map' : scanned?.stage_source;
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
