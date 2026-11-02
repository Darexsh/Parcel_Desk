import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { enviaMilestoneStage, enviaStage } from './status.js';

export const PROVIDER = 'Envía';
// A guía's record and its milestones take a few kilobytes.
export const ENVIA_MAX_BYTES = 256 * 1024;
const NUMBER = /^\d{12}$/;
// A wall clock to the second, written without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The estimate, as the page shows it: day, month and year.
const ETA = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// Envía delivers within Colombia, which keeps one zone without daylight saving.
const ZONE = 'America/Bogota';
// The answer for a guía the service does not know, which the page reports as no tracking information.
const NOT_FOUND = 'no se encontró información para la guía especificada';
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** An Envía guía: twelve digits. */
export function normalizeEnviaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Envía guías are twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Envía returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A record must name the whole guía asked for. */
function bind(row: Record<string, unknown>, number: string): void {
  const guide = row.guiaNumber;
  if (typeof guide !== 'string' || !guide.trim()) throw new SchemaError(PROVIDER, 'Envía returned a record without its guía');
  if (normalizeTrackingNumber(guide) !== number) throw new IndeterminateError(PROVIDER, 'Envía answered for another guía');
}

interface Clock { time?: string; local_time?: string; at: number; wall: string }

/**
 * A wall clock read in Bogotá time: the out-for-delivery and delivery times
 * the reply gives fall in Colombian working hours. Midnight is a date given
 * without its time of day, and stays a date.
 */
function clock(value: string): Clock {
  const match = CLOCK.exec(value);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Envía returned an invalid time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  if (match[2] === '00:00:00') return { local_time: match[1]!, at: zoned.toMillis(), wall };
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis(), wall };
}

/** The guía's record, as the page heads its result: only what the adapter keeps. */
export interface EnviaShipment {
  /** The state code, such as `13` for a delivery. */
  code: string;
  /** The current state's wording, such as "ENTREGADA DIGITALIZADA EN …". */
  state: string;
  location: string;
  /** The current state's wall clock, when the record dates it. */
  date: string;
  service: string;
  /** The estimated delivery day. */
  eta: string | null;
}

function estimate(value: unknown): string | null {
  const match = ETA.exec(clean(value, 16));
  const day = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) }, { zone: 'UTC' }) : null;
  // The estimate is a side note: one in another form is left out.
  return day?.isValid ? day.toISODate() : null;
}

/** The service's own answer for a guía it does not know. */
export function isEnviaNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.success === false && payload.data === null
    && clean(payload.message, 200).toLowerCase().replace(/\.$/, '') === NOT_FOUND;
}

/**
 * The reply of `/tracking/individual`, which the tracking page posts first.
 * A guía the service does not know is HTTP 404 with `success` false and its
 * own message. The record also carries the sender's and recipient's names,
 * phone numbers and addresses, the proof-of-delivery image and payment
 * details, which are not read.
 */
export function readEnviaShipment(payload: unknown, raw: string): EnviaShipment {
  const number = normalizeEnviaNumber(raw);
  if (isEnviaNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || payload.success !== true) {
    throw new SchemaError(PROVIDER, isRecord(payload) && payload.success === false ? 'Envía returned an unexpected error' : 'Envía returned an invalid envelope');
  }
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Envía returned an invalid guía record');
  bind(data, number);
  const code = data.codEstado;
  if (code !== null && code !== undefined && typeof code !== 'string' && typeof code !== 'number') {
    throw new SchemaError(PROVIDER, 'Envía returned an invalid codEstado');
  }
  const date = text(data, 'date', 40);
  if (date) clock(date);
  return {
    code: cleanScalar(code, 16),
    state: text(data, 'estadoActual') || text(data, 'eventCode') || text(data, 'description'),
    location: text(data, 'location', 120),
    date,
    service: text(data, 'serviceType', 80),
    eta: estimate(data.eta),
  };
}

interface Scan { event: CarrierEvent; at: number; wall: string; order: number }

/**
 * A milestone's wording: its title. The sentence under a title the map knows
 * is fixed, so only another title keeps it, as the page shows both.
 */
function milestoneWording(title: string, detail: string): string {
  if (!title) return detail;
  if (!detail || detail === title || enviaMilestoneStage(title)) return title;
  return `${title}${/[.!?:]$/.test(title) ? '' : ':'} ${detail}`;
}

function scan(when: Clock, description: string, location: string, code: string, order: number): Scan {
  const staged = enviaStage(code, description);
  const event: CarrierEvent = {
    ...(when.time ? { time: when.time } : { local_time: when.local_time! }),
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: when.at, wall: when.wall, order };
}

function milestone(row: unknown, number: string, order: number): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Envía returned an invalid milestone');
  bind(row, number);
  const when = clock(text(row, 'date', 40));
  const description = milestoneWording(text(row, 'eventCode'), text(row, 'description', 500));
  return description ? scan(when, description, text(row, 'location', 120), '', order) : null;
}

/**
 * The reply of `/tracking/history/{guía}`, which the page asks next: the
 * guía's milestones, newest first, combined with its record. The record's
 * current state is a scan of its own unless a milestone has its clock.
 */
export function parseEnvia(shipment: EnviaShipment, history: unknown, raw: string): CarrierResult {
  const number = normalizeEnviaNumber(raw);
  if (!isRecord(history) || typeof history.success !== 'boolean') throw new SchemaError(PROVIDER, 'Envía returned an invalid history');
  if (!history.success) throw new IndeterminateError(PROVIDER, 'Envía did not return the history of the guía it found');
  const rows = history.data;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Envía returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Envía returned an oversized history');

  const seen = new Set<string>();
  const scans = rows.map((row, order) => milestone(row, number, order)).filter((item): item is Scan => {
    if (!item) return false;
    const identity = JSON.stringify([item.wall, item.event.description, item.event.location]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (shipment.date && shipment.state) {
    const when = clock(shipment.date);
    if (!scans.some((item) => item.wall === when.wall)) scans.push(scan(when, shipment.state, shipment.location, shipment.code, -1));
  }
  // Newest first; milestones at one clock keep the reply's order, which is newest first too.
  const events = scans.sort((a, b) => b.at - a.at || a.order - b.order).map((item) => item.event);
  const service = shipment.service ? { service_name: shipment.service } : {};

  if (!events.length) {
    // A guía the service knows without a dated state: its current state alone.
    if (!shipment.state) throw new NoHistoryError(PROVIDER);
    const staged = enviaStage(shipment.code, shipment.state);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: shipment.state,
      ...(shipment.code ? { provider_code: shipment.code } : {}),
      last_update: null,
      expected_delivery: staged?.stage === 'delivered' ? null : shipment.eta,
      ...service,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time }),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : shipment.eta,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...service,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
