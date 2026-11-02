import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { servientregaStage, servientregaStateStage } from './status.js';

export const PROVIDER = 'Servientrega';
// A delivered guide carries its proof of delivery as a base64 picture of a few
// hundred kilobytes.
export const SERVIENTREGA_MAX_BYTES = 4 * 1024 * 1024;
// Guide numbers are ten digits, older ones nine. The service reads the number
// as a decimal, so leading zeros name the same guide.
const NUMBER = /^\d{9,10}$/;
// Day, month, year and a time of day to the minute; the reply pads it with a space.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
const ZONE = 'America/Bogota';
// Servientrega's own country id, as the tracker sends it.
const COLOMBIA = 1;
// The step that shows the guide: lower steps ask for a captcha or for details of the shipment first.
const SHOWN = 4;
const MAX_SCANS = 300;
const MAX_EVENTS = 100;

/** A Servientrega guide number: nine or ten digits, without leading zeros. */
export function normalizeServientregaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).replace(/^0+/, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Servientrega guide numbers are nine or ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Servientrega returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: a wall clock to the minute. Servientrega carries parcels
 * within Colombia, whose one zone keeps no daylight saving, so a domestic
 * guide's clocks are read in Bogotá time. Another guide keeps its wall clocks.
 */
function clock(value: string, domestic: boolean): { time?: string; local_time?: string; at: number } {
  const match = CLOCK.exec(value);
  if (!match) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid time');
  const [, day, month, year, hour, minute] = match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}`;
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm") !== wall) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid time');
  // Wall clocks are ordered as if read in Bogotá.
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  if (!domestic) return { local_time: wall, at: zoned.toMillis() };
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

interface Scan { event: CarrierEvent; at: number; order: number }

/** One movement: its process code, the carrier's Spanish wording with any incident, the town and the clock. */
function readScan(row: unknown, order: number, domestic: boolean): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid movement');
  const code = cleanScalar(row.IdProceso, 16);
  const movement = text(row, 'movimiento');
  if (!/^\d+$/.test(code) || !movement) throw new SchemaError(PROVIDER, 'Servientrega returned a movement without its code or wording');
  const incident = text(row, 'Novedad');
  const description = incident ? `${movement} (${incident})` : movement;
  const location = text(row, 'ubicacion');
  const when = clock(text(row, 'fecha', 32), domestic);
  const staged = servientregaStage(code, movement);
  const event: CarrierEvent = {
    ...(when.time ? { time: when.time } : { local_time: when.local_time! }),
    description,
    ...(location ? { location } : {}),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: when.at, order };
}

function country(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SchemaError(PROVIDER, `Servientrega returned an invalid ${key}`);
  return value;
}

/** The envelope's checks: the step the tracker reached and whether it shows the guide. */
function shownResults(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Number.isInteger(payload.ValidationNumber) || !Number.isInteger(payload.Code)) {
    throw new SchemaError(PROVIDER, 'Servientrega returned an invalid envelope');
  }
  if (payload.ValidationNumber === 1) throw new ChallengeError(PROVIDER, 'Servientrega asked for a captcha before showing the guide');
  if (payload.ValidationNumber === 2 || payload.ValidationNumber === 3) {
    throw new ChallengeError(PROVIDER, 'Servientrega asked to confirm details of the shipment before showing the guide');
  }
  if (payload.ValidationNumber !== SHOWN || payload.Code !== 1) throw new SchemaError(PROVIDER, 'Servientrega returned an unexpected lookup state');
  if (!Array.isArray(payload.Results) || payload.Results.length !== 1) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid guide list');
  return payload.Results;
}

/**
 * The reply of the tracker's `ControlRastreovalidaciones` for one guide. The
 * guide's record names it, holds its overall state and its movements, oldest
 * first; a guide Servientrega does not know is the single result `null`.
 * Names, addresses, contacts, the proof-of-delivery picture, the signatory and
 * customer-service tasks in the record are not read.
 */
export function parseServientrega(payload: unknown, raw: string): CarrierResult {
  const number = normalizeServientregaNumber(raw);
  const [record] = shownResults(payload);
  if (record === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(record)) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid guide');
  const guide = cleanScalar(record.numeroGuia, 64).replace(/^0+/, '');
  if (!/^\d+$/.test(guide)) throw new SchemaError(PROVIDER, 'Servientrega returned an invalid guide number');
  if (guide !== number) throw new IndeterminateError(PROVIDER, 'Servientrega answered for another guide');

  const state = text(record, 'estadoActual');
  const stateStage = state ? servientregaStateStage(state) : undefined;
  const service = text(record, 'tipoProducto', 100);
  const movements = record.movimientos ?? [];
  if (!Array.isArray(movements)) throw new SchemaError(PROVIDER, 'Servientrega returned invalid movements');
  if (movements.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Servientrega returned an oversized history');
  const origin = country(record, 'IdPaisOrigen');
  const destination = country(record, 'IdPaisDestino');
  const domestic = origin === COLOMBIA && destination === COLOMBIA;

  const seen = new Set<string>();
  // Newest first; equal clocks put the later movement of the reply first.
  const scans = movements.map((row, order) => readScan(row, order, domestic))
    .filter(({ event }) => {
      const identity = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.description, event.location]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).sort((a, b) => b.at - a.at || b.order - a.order);
  const events = scans.map(({ event }) => event);
  // A guide delivered back to its sender: its deliveries are the return's.
  if (stateStage === 'returned') {
    for (const event of events) if (event.stage === 'delivered') event.stage = 'returned';
  }

  if (!events.length) {
    if (!state) throw new SchemaError(PROVIDER, 'Servientrega returned a guide without its state or movements');
    return {
      status: stateStage ? languageStageStatus(stateStage) : 'unknown',
      ...(stateStage ? { current_stage: stateStage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: state,
      last_update: null,
      expected_delivery: null,
      ...(service ? { service_name: service } : {}),
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  // A delivered guide's state stands over a movement logged after the delivery.
  const ended = stateStage === 'delivered' || stateStage === 'returned';
  const final = ended ? events.find((event) => event.stage === stateStage) : undefined;
  const current = ended ? final : events.find((event) => event.stage);
  const stage = (ended ? stateStage : current?.stage) as Stage | undefined;
  const source = current?.stage_source ?? 'carrier_map';
  // The guide's own delivery time is the courier's report, which a verification
  // follows. Before a delivery the field holds another date.
  const reported = stateStage === 'delivered' && domestic ? text(record, 'fechaRealEntrega', 32) : '';
  const delivered = reported ? clock(reported, true).time : final?.stage === 'delivered' ? final.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: final?.description ?? (ended ? state : newest.description!),
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
