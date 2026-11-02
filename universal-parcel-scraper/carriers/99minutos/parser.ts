import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isValidUpsTrackingNumber } from '../../core/detection/ups.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { INCIDENT_ROW, ninetynineIncident, ninetynineStage, ninetynineWording } from './status.js';

export const PROVIDER = '99minutos';
// The search answers about a hundred bytes per number and the summary a few
// hundred; a history is a list of short rows.
export const CONCERNS_MAX_BYTES = 64_000;
export const TRACK_MAX_BYTES = 256_000;
export const DETAIL_MAX_BYTES = 1_000_000;
// A guía is the shipment's tracking id: nine or ten digits in every known
// sample. The search also resolves shops' order references, which are never
// taken here: they can name another shop's parcel.
const NUMBER = /^[1-9]\d{6,9}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const RECIPIENT_CHECK = '99minutos asks for the recipient’s email, phone or name before it shows this shipment';
// What the tracker shows for a summary whose code is an incident.
const INCIDENT_NOTICE = 'Tu pedido presenta una incidencia. Te recomendamos contactar a nuestro equipo de atención a cliente para obtener más detalles.';
// Colombia's tracker lists only these milestones.
const COLOMBIA_ROWS: ReadonlySet<string> = new Set(['Created', 'Collected', 'Linehaul', 'ToDelivery', 'Delivery']);
// Statuses whose estimated day the tracker shows, from a station on; the way
// back to the shop is no delivery estimate, and the tracker hides the estimate
// in Chile and Peru.
const ESTIMATED: ReadonlySet<string> = new Set(['Warehouse', 'Linehaul', 'P99', 'ToP99', 'ToDelivery', 'UnsuccessfulDelivery']);
// The zone that gives an estimate its day. The tracker uses the viewer's own;
// Mexico's is the carrier's home zone.
const ESTIMATE_ZONES: Readonly<Record<string, string>> = {
  MEX: 'America/Mexico_City', COL: 'America/Bogota', ARG: 'America/Argentina/Buenos_Aires',
};

/** A guía the tracker can look up: digits only, as the search takes them. */
export function normalizeNinetynineNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw.trim()) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '99minutos guías are seven to ten digits');
  return number;
}

/** An optional text field; any other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `99minutos returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A tracking id, which the service sends as a number. */
function trackingId(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : '';
}

/** An instant with its own offset, to the second; null when it has none. */
function instant(value: string): { time: string; timestamp: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) return null;
  const second = parsed.set({ millisecond: 0 });
  return { time: second.toISO({ suppressMilliseconds: true }), timestamp: second.toMillis() };
}

/**
 * The search's answer for the requested guía: `POST /api/v1/tracking/concerns`
 * lists one entry per number asked. `success` names the tracking id it found,
 * which must be the guía itself; `error` is the tracker's "El número de
 * seguimiento no es válido" for a number it does not know; `validate` asks
 * for the recipient's email, phone or name first.
 */
export function readConcern(payload: unknown, raw: string): void {
  const number = normalizeNinetynineNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, '99minutos returned an unexpected search reply');
  if (payload.length !== 1) throw new IndeterminateError(PROVIDER, '99minutos answered the search with no single entry');
  const [entry] = payload as unknown[];
  if (!isRecord(entry)) throw new SchemaError(PROVIDER, '99minutos returned an invalid search entry');
  const requested = typeof entry.requested_tracking === 'string' ? entry.requested_tracking
    : trackingId(entry.requested_tracking);
  if (requested !== number) throw new IndeterminateError(PROVIDER, '99minutos answered the search for another number');
  if (entry.status === 'error') throw new NotFoundError(PROVIDER);
  if (entry.status === 'validate') throw new InputRequiredError(PROVIDER, 'recipient verification', RECIPIENT_CHECK);
  if (entry.status !== 'success') throw new SchemaError(PROVIDER, '99minutos returned an unknown search status');
  // A reference of a shop's that matched another shipment says nothing about this guía.
  if (trackingId(entry.tracking_id) !== number) {
    throw new IndeterminateError(PROVIDER, '99minutos matched the number to another shipment');
  }
}

/** A refusal of the summary or history for want of the recipient's details. */
export function recipientCheckRequired(): InputRequiredError {
  return new InputRequiredError(PROVIDER, 'recipient verification', RECIPIENT_CHECK);
}

/** The parts of the summary the adapter reads. */
export interface NinetynineSummary {
  readonly status: string;
  readonly code: number | null;
  readonly country: string;
  readonly eta: number | null;
  /** UPS carries the parcel abroad, and the tracker sends the visitor there. */
  readonly ups: boolean;
  readonly handoff: string | null;
}

/**
 * The summary `POST /api/v1/tracking/{id}/track` gives: the tracking id, the
 * status name and code, the country, the estimate and the delivery type. Its
 * tracking id must be the guía. The shop's internal key is read only on an
 * international shipment, whose UPS number it is; origin and destination
 * addresses and stations are never read.
 */
export function parseNinetynineSummary(payload: unknown, raw: string): NinetynineSummary {
  const number = normalizeNinetynineNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, '99minutos returned an unexpected summary');
  if (trackingId(payload.tracking_id) !== number) {
    throw new IndeterminateError(PROVIDER, '99minutos answered with a shipment the number does not identify');
  }
  const status = text(payload, 'status_web', 40);
  if (!status) throw new SchemaError(PROVIDER, '99minutos returned a summary without its status');
  const code = payload.status;
  if (code !== null && code !== undefined && !Number.isInteger(code)) throw new SchemaError(PROVIDER, '99minutos returned an invalid status code');
  const eta = text(payload, 'eta', 40);
  const estimate = eta ? instant(eta) : null;
  if (eta && !estimate) throw new SchemaError(PROVIDER, '99minutos returned an estimate without an offset');
  const ups = text(payload, 'delivery_type', 20) === 'INTR';
  const key = ups ? normalizeTrackingNumber(text(payload, 'internal_key', 64)) : '';
  return {
    status, code: (code as number | null | undefined) ?? null, country: text(payload, 'country', 8).toUpperCase(),
    eta: estimate?.timestamp ?? null, ups, handoff: key && isValidUpsTrackingNumber(key) ? key : null,
  };
}

interface Row {
  readonly event: CarrierEvent & { time: string; description: string; provider_code: string };
  readonly timestamp: number;
  readonly index: number;
}

/**
 * One row of the history: its status name and clock. Its remarks name drivers,
 * stations' staff and whoever took the parcel, and its evidence is the proof of
 * delivery: neither is read.
 */
function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, '99minutos returned an invalid history row');
  const status = text(value, 'status', 40);
  if (!status) throw new SchemaError(PROVIDER, '99minutos returned a history row without its status');
  const clock = instant(text(value, 'created_at', 40));
  if (!clock) throw new SchemaError(PROVIDER, '99minutos returned a history row without an offset clock');
  const stage = ninetynineStage(status);
  return {
    event: { time: clock.time, description: ninetynineWording(status) ?? status, provider_code: status,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
    timestamp: clock.timestamp,
    index,
  };
}

/** The estimate's day, while the tracker shows one and it is not older than the newest row. */
function estimatedDay(summary: NinetynineSummary, newest: Row | undefined): string | null {
  if (summary.eta === null || !ESTIMATED.has(summary.status) || ninetynineIncident(summary.code)) return null;
  const zone = ESTIMATE_ZONES[summary.country];
  if (!zone) return null;
  const day = DateTime.fromMillis(summary.eta, { zone }).toISODate()!;
  if (newest && day < DateTime.fromMillis(newest.timestamp, { zone }).toISODate()!) return null;
  return day;
}

/**
 * A shipment from its summary and, unless UPS carries it, the history
 * `POST /api/v1/tracking/{id}/detail` gives oldest first. Rows are listed
 * newest first, once each, and in Colombia only the milestones its tracker
 * shows. The summary's status decides the stage, and a code the tracker shows
 * as an incident makes it a problem.
 */
export function parseNinetynine(summary: NinetynineSummary, detail: unknown, raw: string): CarrierResult {
  normalizeNinetynineNumber(raw);
  let rows: Row[] = [];
  if (detail !== null) {
    if (!Array.isArray(detail) || detail.length > MAX_ROWS) throw new SchemaError(PROVIDER, '99minutos returned an invalid history');
    const seen = new Set<string>();
    rows = (detail as unknown[]).map(rowOf)
      .filter((row) => summary.country !== 'COL' || COLOMBIA_ROWS.has(row.event.provider_code))
      .filter((row) => {
        const key = `${row.event.time}|${row.event.provider_code}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // Newest first; of two rows on one clock, the later in the reply is newer.
      .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  }
  const events = rows.map((row) => row.event);
  const newest = rows[0];
  const incident = ninetynineIncident(summary.code);
  const named = ninetynineStage(summary.status);
  const staged = rows.find((row) => row.event.stage)?.event.stage as Stage | undefined;
  const stage: Stage | undefined = incident ? 'exception' : named ?? staged;
  const wording = summary.status === 'NotShowIncidence' ? INCIDENT_ROW : ninetynineWording(summary.status);
  const delivered = stage === 'delivered' ? rows.find((row) => row.event.provider_code === 'Delivery') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: incident ? INCIDENT_NOTICE : wording ?? newest?.event.description ?? summary.status,
    ...(events.length ? {} : { provider_code: summary.status, summary_only: true }),
    last_update: newest?.event.time ?? null,
    expected_delivery: estimatedDay(summary, newest),
    ...(delivered ? { delivered_at: delivered.event.time } : {}),
    ...(summary.handoff ? { delivery_carrier: 'ups', delivery_tracking_number: summary.handoff } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
