import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { integralPackStage } from './status.js';

export const PROVIDER = 'Integral Pack';
// A delivered guide's reply is about a kilobyte.
export const INTEGRAL_PACK_MAX_BYTES = 256 * 1024;
// The agency's point of sale, the letter and the number, after the tracker's
// own `IPE` when it is typed; the former form offered the letters A, B, C and P.
const GUIDE = /^(?:IPE)?(\d{1,4})([ABCP])(\d{1,8})$/;
// A wall clock to the second, sometimes with a fraction, without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The delivery type of a parcel the recipient collects at the destination agency.
const AT_AGENCY = 2;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A guide: its point of sale, letter and number, and the code the tracker sends for it. */
export interface IntegralPackGuide {
  pointOfSale: number;
  letter: string;
  number: number;
  /** `IPE-`, the point of sale in four digits, the letter and the number in eight, as the tracking page sends them. */
  code: string;
}

/** A guide for Integral Pack's tracker; anything else is not a guide it issues. */
export function normalizeIntegralPackGuide(raw: string): IntegralPackGuide {
  const match = typeof raw === 'string' && raw.length <= 64 ? GUIDE.exec(normalizeTrackingNumber(raw)) : null;
  const pointOfSale = match ? Number(match[1]) : 0;
  const number = match ? Number(match[3]) : 0;
  if (!match || pointOfSale === 0 || number === 0) {
    throw new InvalidInputError(PROVIDER, 'Integral Pack guides are a point of sale of up to four digits, a letter and a number of up to eight digits');
  }
  const code = `IPE-${match[1]!.padStart(4, '0')}-${match[2]}-${match[3]!.padStart(8, '0')}`;
  return { pointOfSale, letter: match[2]!, number, code };
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Integral Pack returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A part of the guide's identity, a whole nonnegative number. */
function guidePart(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`Integral Pack returned a guide without its ${key}`);
  return value;
}

/**
 * An event's clock, the wall clock to the second. The reply names no zone and
 * the page shows the digits as they come, so the clock stays local.
 */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  // Parsing in UTC checks the calendar digits only. Luxon rolls 24:00 over to the next day.
  const parsed = match ? DateTime.fromISO(match[1]!, { zone: 'UTC' }) : null;
  if (!match || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== match[1]) invalid('Integral Pack returned an invalid event time');
  return match[1];
}

interface Scan { index: number; key: string; event: CarrierEvent }

/** An event, or null when it has no name. Its place is the town the tracker names. */
function projectRow(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) invalid('Integral Pack returned an invalid event');
  const local = wallClock(text(row, 'FechaYHora', 40));
  const description = text(row, 'NombreEvento', 200);
  if (!description) return null;
  const location = text(row, 'LocalidadNombre', 120);
  const staged = integralPackStage(description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { index, key: JSON.stringify([local, description.toLowerCase(), location]), event };
}

/**
 * The agency a parcel to collect waits at: its name, then its address. A
 * parcel brought to the door has none; its address is the recipient's.
 */
function pickupPoint(shipment: Record<string, unknown>): string {
  if (shipment.TipoEntrega !== AT_AGENCY || !isRecord(shipment.AgenciaDestino)) return '';
  const name = text(shipment.AgenciaDestino, 'Nombre', 120);
  return name ? [name, text(shipment.AgenciaDestino, 'Direccion', 160)].filter(Boolean).join('\n') : '';
}

/** The weight of the guide's parcels, when the reply gives a positive one. */
function weight(shipment: Record<string, unknown>): number | undefined {
  const parcels = shipment.DetalleBultos;
  const kg = isRecord(parcels) ? parcels.PesoTotalKg : undefined;
  return typeof kg === 'number' && Number.isFinite(kg) && kg > 0 ? kg : undefined;
}

/**
 * The reply of the tracking page's `/api/seguimiento/buscar` for one guide: the
 * current state, the guide's identity and parcels, and its events oldest
 * first. It answers HTTP 200 with an empty list for a guide it does not know.
 * The guide must be the one asked. The sender, the recipient, the delivery
 * address, the payment and the page's own progress step are never read.
 */
export function parseIntegralPack(payload: unknown, raw: string): CarrierResult {
  const guide = normalizeIntegralPackGuide(raw);
  if (Array.isArray(payload)) {
    if (!payload.length) throw new NotFoundError(PROVIDER, 'Integral Pack has no shipment under this guide');
    invalid('Integral Pack returned a list in place of the guide');
  }
  if (!isRecord(payload)) invalid('Integral Pack returned an invalid reply');
  if (payload.Error !== undefined && payload.Error !== null) throw new IndeterminateError(PROVIDER, 'Integral Pack did not complete the lookup');
  const shipment = payload.DatosEnvio;
  if (!isRecord(shipment)) invalid('Integral Pack returned a reply without its guide');
  const letter = text(shipment, 'Tipo', 4).toUpperCase();
  if (!letter) invalid('Integral Pack returned a guide without its letter');
  if (guidePart(shipment, 'Serie') !== guide.pointOfSale || letter !== guide.letter || guidePart(shipment, 'Numero') !== guide.number) {
    throw new IndeterminateError(PROVIDER, 'Integral Pack answered for another guide');
  }
  const rows = payload.VentaEventos ?? [];
  if (!Array.isArray(rows)) invalid('Integral Pack returned a guide with invalid events');
  if (rows.length > MAX_ROWS) invalid('Integral Pack returned an oversized history');
  const current = payload.EstadoActual ?? {};
  if (!isRecord(current)) invalid('Integral Pack returned an invalid current state');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row: unknown, index) => {
    const scan = projectRow(row, index);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; of two events in one second the later row is newer.
  const events = scans.sort((a, b) => String(b.event.local_time).localeCompare(String(a.event.local_time)) || b.index - a.index)
    .map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The current state's name settles the status, else the newest staged event.
  const name = text(current, 'EstadoActualNombre', 120);
  const state = name ? integralPackStage(name) : null;
  const stage = (state?.stage ?? scanned?.stage) as Stage | undefined;
  const source = state && state.stage !== scanned?.stage ? state.source : scanned?.stage_source;
  const pickup = pickupPoint(shipment);
  const kg = weight(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(kg !== undefined ? { weight_kg: kg } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
