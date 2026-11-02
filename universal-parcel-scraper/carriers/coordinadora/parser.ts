import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { coordinadoraStage } from './status.js';

export const PROVIDER = 'Coordinadora';
// A guide's reply is a few kilobytes; a number many people mistyped carries
// hundreds of complaints filed under it.
export const COORDINADORA_MAX_BYTES = 1024 * 1024;
// The tracker's own check: "Debe contener 11 dígitos".
const NUMBER = /^\d{11}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// To the second; incidents add microseconds.
const CLOCK = /^(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/;
const ZONE = 'America/Bogota';
// The state the tracker shows as "No se encontró la guía consultada".
const NOT_FOUND = '0';
const DELIVERED = '6';
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A guide number for Coordinadora's tracker: eleven digits. */
export function normalizeCoordinadoraNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Coordinadora guide numbers are eleven digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Coordinadora returned an invalid ${key}`);
  return clean(value, maxLength);
}

function rows(entry: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = entry[key] ?? [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new SchemaError(PROVIDER, `Coordinadora returned an invalid ${key}`);
  return value;
}

/**
 * A row's clock: a date and a time of day, both optional. Coordinadora works
 * within Colombia, whose one zone keeps no daylight saving, so a dated clock
 * is read in Bogotá time. A row marked international keeps its wall clock,
 * and a date without a time of day stays a date.
 */
function clock(row: Record<string, unknown>, international: boolean): { time?: string; local_time?: string; at: number } | null {
  const date = text(row, 'fecha', 16);
  const hour = text(row, 'hora', 32);
  if (!date) {
    if (hour) throw new SchemaError(PROVIDER, 'Coordinadora returned a time without its date');
    return null;
  }
  const match = CLOCK.exec(hour);
  const wall = hour ? `${date}T${match?.[1] ?? ''}` : date;
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  const form = hour ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd';
  if (!DATE.test(date) || (hour && !match) || !checked.isValid || checked.toFormat(form) !== wall) {
    throw new SchemaError(PROVIDER, 'Coordinadora returned an invalid time');
  }
  // Wall clocks are ordered as if read in Bogotá.
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  if (!hour || international) return { local_time: wall, at: zoned.toMillis() };
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

interface Row { event: CarrierEvent; at: number; order: number }

/** A state or an incident: its code, the carrier's Spanish wording and its clock, or null without a date. */
function readRow(row: Record<string, unknown>, order: number): Row | null {
  const code = cleanScalar(row.codigo, 16);
  const description = text(row, 'descripcion');
  if (!code || !description) throw new SchemaError(PROVIDER, 'Coordinadora returned a row without its code or wording');
  if (row.internacional !== undefined && typeof row.internacional !== 'boolean') {
    throw new SchemaError(PROVIDER, 'Coordinadora returned an invalid internacional');
  }
  const when = clock(row, row.internacional === true);
  if (!when) return null;
  const staged = coordinadoraStage(code, description);
  const event: CarrierEvent = {
    ...(when.time ? { time: when.time } : { local_time: when.local_time! }),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: when.at, order };
}

/**
 * The reply of the tracker's `tracking/rastreo` for one guide. `estado`
 * holds the guide's states, the newest of each step, and `novedad` its
 * incidents, both newest first. A guide Coordinadora does not know has the
 * single state `0`, which the tracker reports as not found. A full record
 * names the guide; a short one, kept for an old or unused guide, does not.
 */
export function parseCoordinadora(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCoordinadoraNumber(raw);
  if (!isRecord(payload) || typeof payload.isError !== 'boolean') throw new SchemaError(PROVIDER, 'Coordinadora returned an invalid envelope');
  if (payload.isError) {
    // Its refusal of a malformed guide: the request no longer fits the service.
    if (payload.code === 'BAD_MESSAGE') throw new SchemaError(PROVIDER, 'Coordinadora refused the lookup as malformed');
    throw new IndeterminateError(PROVIDER, 'Coordinadora did not complete the lookup');
  }
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) throw new SchemaError(PROVIDER, 'Coordinadora returned an invalid guide list');
  const entry = data[0];
  const states = rows(entry, 'estado');
  if (!states.length) throw new SchemaError(PROVIDER, 'Coordinadora returned a guide without its state');
  const echoed = entry.codigo_remision;
  if (echoed !== undefined && echoed !== null) {
    const guide = cleanScalar(echoed, 64);
    if (!guide) throw new SchemaError(PROVIDER, 'Coordinadora returned an invalid guide number');
    if (guide !== number) throw new IndeterminateError(PROVIDER, 'Coordinadora answered for another guide');
  }
  if (cleanScalar(states[0]!.codigo, 16) === NOT_FOUND) {
    if (states.length > 1) throw new SchemaError(PROVIDER, 'Coordinadora returned an unknown guide with states');
    throw new NotFoundError(PROVIDER);
  }
  const incidents = rows(entry, 'novedad');
  if (states.length + incidents.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Coordinadora returned an oversized history');

  const seen = new Set<string>();
  // Newest first; equal clocks keep the reply's order, which is newest first too.
  const ordered = [...states, ...incidents].map((row, order) => readRow(row, order))
    .filter((row): row is Row => {
      if (!row) return false;
      const { event } = row;
      const identity = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.description]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).sort((a, b) => b.at - a.at || a.order - b.order);
  const events = ordered.map(({ event }) => event);

  if (!events.length) {
    // An undated state alone: a guide made and never handed over, or an unused one.
    const code = cleanScalar(states[0]!.codigo, 16);
    const description = text(states[0]!, 'descripcion');
    const staged = coordinadoraStage(code, description);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: description || null,
      provider_code: code,
      last_update: null,
      expected_delivery: null,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  // A delivery stands over an incident reported after it, as the newest state.
  const latestState = ordered.find(({ order, event }) => order < states.length && event.stage)?.event;
  const delivery = latestState?.provider_code === DELIVERED && latestState.stage === 'delivered' ? latestState : undefined;
  const current = delivery ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: (delivery ?? newest).description!,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
