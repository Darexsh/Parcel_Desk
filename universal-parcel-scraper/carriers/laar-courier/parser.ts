import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { laarMappedStage, laarStage } from './status.js';

export const PROVIDER = 'Laar Courier';
// A delivered guía's replies are each under two kilobytes.
export const LAAR_MAX_BYTES = 256 * 1024;
// Letters and digits with at least one digit. The guías seen are three
// letters and ten digits; the tracker itself takes any text.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The service's clocks: a date, a time and up to seven decimals of a second, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;
// The timeline step for a created guía.
const CREATED = '2';
// Steps the page leaves out of the timeline.
const VOIDED = /anulad/i;

/** A guía for Laar's tracker, in capitals; anything else is not one it issues. */
export function normalizeLaarNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Laar guías are six to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Laar returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The rows of one of the tracker's replies, `{"isSuccess":…,"objetoADeserializar":[…]}`,
 * or null when the service reports that it failed and gives none. The
 * timeline's steps come as JSON text inside the JSON reply.
 */
function rows(payload: unknown, what: string): Record<string, unknown>[] | null {
  if (!isRecord(payload) || !Object.hasOwn(payload, 'objetoADeserializar')) throw new SchemaError(PROVIDER, `Laar returned an invalid ${what} reply`);
  let list = payload.objetoADeserializar;
  if (list === null && payload.isSuccess === false) return null;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (cause) {
      throw new SchemaError(PROVIDER, `Laar returned unreadable ${what}`, { cause });
    }
  }
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, `Laar returned invalid ${what}`);
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, `Laar returned oversized ${what}`);
  if (!list.every(isRecord)) throw new SchemaError(PROVIDER, `Laar returned an invalid row of ${what}`);
  return list;
}

/** Rows a lookup cannot go without: a reply the service marks as failed is inconclusive. */
function required(payload: unknown, what: string): Record<string, unknown>[] {
  const list = rows(payload, what);
  if (list === null || (isRecord(payload) && payload.isSuccess !== true)) {
    throw new IndeterminateError(PROVIDER, 'Laar did not complete the lookup');
  }
  return list;
}

/**
 * The guía's record from `/api/buscar/guia`, which the page reads first. An
 * empty list is the page's "No se encontró la guía". The record does not
 * name the guía.
 */
export function laarSearchRow(payload: unknown): Record<string, unknown> {
  const [row] = required(payload, 'search');
  if (!row) throw new NotFoundError(PROVIDER);
  return row;
}

/**
 * The guía's label from `/api/etiqueta/deprati`, the page's next read, which
 * names the guía. A guía with a record but no label has no timeline on the page.
 */
export function laarLabelRow(payload: unknown, number: string): Record<string, unknown> {
  const [row] = required(payload, 'label');
  if (!row) throw new NoHistoryError(PROVIDER);
  if (typeof row.g01Id !== 'string') throw new SchemaError(PROVIDER, 'Laar returned a label without its guía');
  if (clean(row.g01Id, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Laar answered for another guía');
  return row;
}

/** The state id the page passes on when it asks for the timeline. */
export function laarCurrentState(label: Record<string, unknown>): number {
  const state = Number(cleanScalar(label.estadoActual, 8));
  return Number.isInteger(state) && state >= 0 ? state : 0;
}

/**
 * A step's clock, to the second. The service's clocks carry no zone; the page
 * shows their digits as they come, so the clock stays local. Null for a step
 * not reached yet, or .NET's empty date.
 */
function clock(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) throw new SchemaError(PROVIDER, 'Laar returned an invalid scan time');
  const local = `${match[1]}T${match[2]}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Laar returned an invalid scan time');
  return parsed.year < 2000 ? null : local;
}

/** A state id as the map keys it: `2.00` is 2 and `6.01` stays. */
function code(row: Record<string, unknown>, key: string): string {
  const value = cleanScalar(row[key], 12);
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new SchemaError(PROVIDER, `Laar returned an invalid ${key}`);
  return String(Number(value));
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

interface Scan { event: CarrierEvent; order: number }

function scan(local: string, description: string, provider: string, location: string, order: number): Scan {
  const staged = laarStage(provider, description);
  return { order, event: {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The timeline's steps from `/api/estados`, each dated when the guía reached
 * it, with the regional office that recorded it. The created step carries the
 * guía's latest assignment to a client, which can come after its collection;
 * dated after a later step, it is no part of the parcel's history.
 */
function steps(list: readonly Record<string, unknown>[]): Scan[] {
  const dated = list.flatMap((row, index) => {
    const name = text(row, 'P33_Alias', 120);
    if (!name) throw new SchemaError(PROVIDER, 'Laar returned a step without its name');
    const id = code(row, 'Id');
    const local = clock(row, 'G28_FechaEstado');
    if (!local || VOIDED.test(name)) return [];
    return [{ id, ...scan(local, name, id, text(row, 'RegionalAcopio', 120), index) }];
  });
  const later = dated.filter((step) => step.id !== CREATED).map((step) => step.event.local_time as string).sort()[0];
  return dated.filter((step) => step.id !== CREATED || !later || (step.event.local_time as string) <= later);
}

/** The transit details from `/api/estadosTransito`, which the page lists under the in-transit step. Each names its guía. */
function transit(list: readonly Record<string, unknown>[], number: string): Scan[] {
  return list.flatMap((row, index) => {
    if (typeof row.guia !== 'string') throw new SchemaError(PROVIDER, 'Laar returned a transit detail without its guía');
    if (clean(row.guia, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Laar answered for another guía');
    const name = text(row, 'nombre', 120);
    if (!name) throw new SchemaError(PROVIDER, 'Laar returned a transit detail without its name');
    const local = clock(row, 'fecha');
    return local ? [scan(local, name, code(row, 'p33Id'), '', MAX_ROWS + index)] : [];
  });
}

/**
 * The problems reported from `/api/novedades`, by their own wording. The
 * courier's and customer service's remarks beside them are not kept.
 */
function incidents(list: readonly Record<string, unknown>[]): Scan[] {
  return list.flatMap((row, index) => {
    const wording = clean(text(row, 'novedad', 200).replace(PHONE, '')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
    const local = clock(row, 'fechaHora');
    return wording && local ? [scan(local, wording, '', '', 2 * MAX_ROWS + index)] : [];
  });
}

/**
 * The summary's word for a parcel whose journey ended or stopped, which the
 * page shows as the guía's state over the timeline.
 */
function summaryStage(state: string): ClassifiedWording | null {
  if (!state) return null;
  const mapped: Stage | undefined = laarMappedStage('', state);
  const staged = mapped ? { stage: mapped, source: 'carrier_map' } : classifyWording(state, 'in_transit');
  return staged.source !== 'none' && ['delivered', 'returned', 'exception'].includes(staged.stage) ? staged : null;
}

export interface LaarReplies {
  search: unknown;
  label: unknown;
  steps: unknown;
  transit: unknown;
  incidents: unknown;
}

/**
 * The replies the tracking page reads for one guía. The label names the guía
 * and binds the rest, which do not. A transit or problem list the service
 * fails to read is left out, as the page leaves it out.
 */
export function parseLaar(replies: LaarReplies, raw: string): CarrierResult {
  const number = normalizeLaarNumber(raw);
  const record = laarSearchRow(replies.search);
  laarLabelRow(replies.label, number);
  const state = text(record, 'estado', 80);
  const timeline = rows(replies.steps, 'steps');
  if (!timeline) throw new IndeterminateError(PROVIDER, 'Laar did not complete the lookup');
  const details = rows(replies.transit, 'transit details') ?? [];
  const problems = rows(replies.incidents, 'incidents') ?? [];

  const seen = new Set<string>();
  const events = [...steps(timeline), ...transit(details, number), ...incidents(problems)]
    // Newest first; a detail comes above the step it details at the same second.
    .sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.order - a.order)
    .map(({ event }) => event)
    .filter((event) => {
      const key = JSON.stringify([event.local_time, event.provider_code, event.description, event.location]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const weight = typeof record.pesoKilos === 'number' && Number.isFinite(record.pesoKilos) && record.pesoKilos > 0 ? record.pesoKilos : null;
  const summary = summaryStage(state);
  const newest = events[0];
  if (!newest) {
    // A guía created and not collected yet has its state and no dated step.
    const staged = state ? laarStage('', state) : null;
    if (!staged) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(staged.stage), current_stage: staged.stage, current_stage_source: staged.source,
      last_status_text: state, last_update: null, expected_delivery: null, ...(weight ? { weight_kg: weight } : {}),
      summary_only: true, events: [] };
  }
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary.stage !== scanned?.stage ? summary.source : scanned?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
