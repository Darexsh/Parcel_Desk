import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { glsSpainStage } from './status.js';

export const PROVIDER = 'GLS Spain';

// The service takes a shipment number, a parcel's barcode or the sender's
// reference, all letters and digits.
const NUMBER = /^[A-Z0-9]{5,40}$/;
// The scans that leave the parcel at a GLS point.
const AT_POINT = new Set(['receivedOnParcel', 'deliveredOnParcel']);
const MAX_SCANS = 500;
const MAX_EVENTS = 100;

/** A number as the tracking service takes it: letters and digits, without spaces or dashes. */
export function normalizeGLSSpainNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'GLS Spain looks up shipment numbers, parcel barcodes and sender references of letters and digits');
  }
  return number;
}

/** The delivery postcode, which the service asks for with every number. */
export function normalizeGLSSpainPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'postcode', 'GLS Spain requires the delivery postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'GLS Spain requires a valid delivery postcode');
  return postcode;
}

/** An optional text field; an object, array or other non-scalar is a changed reply. */
function text(row: JsonObject, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `GLS Spain returned an invalid ${key}`);
  return typeof value === 'number' ? cleanScalar(value, maxLength) : clean(value, maxLength);
}

/** One scan: its state code, sentence and instant. Its reason is never read. */
function scan(row: unknown): CarrierEvent & { description: string; provider_code: string } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GLS Spain returned an invalid scan');
  const code = text(row, 'code', 64);
  const description = text(row, 'description');
  if (!code || !description) throw new SchemaError(PROVIDER, 'GLS Spain returned a scan without a state or wording');
  let time: string | undefined;
  if (row.at !== null && row.at !== undefined) {
    // The app reads the clock as an instant and shows it in the reader's zone.
    const at = explicitOffsetTime(row.at);
    if (!at) throw new SchemaError(PROVIDER, 'GLS Spain returned a scan without an offset time');
    time = at.iso;
  }
  const stage = glsSpainStage(code, description);
  return { ...(time ? { time } : {}), description, provider_code: code,
    ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
}

/** The shipment's estimated delivery day in Spain; the service sends a day or an instant. */
function estimatedDay(state: JsonObject): string | null {
  const raw = text(state, 'estimatedDeliveryDate', 64);
  if (!raw) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? firstOccurrence(DateTime.fromISO(raw, { zone: 'Europe/Madrid' }))
    : explicitOffsetTime(raw) ? DateTime.fromISO(raw, { setZone: true }).setZone('Europe/Madrid') : null;
  return day?.isValid ? day.toISODate() : null;
}

/**
 * The GLS point the parcel waits at or was collected from, by name, when the
 * scan that left it there names the same point. The reply's point is the
 * destination depot otherwise.
 */
function pickupPoint(found: JsonObject, events: readonly CarrierEvent[], stage: string | undefined): string {
  // The newest scan, or on a delivered parcel the one before its collection.
  const left = stage === 'ready_for_pickup' ? events[0]
    : stage === 'delivered' && events[0]?.stage === 'delivered' ? events[1] : undefined;
  if (!left || !AT_POINT.has(left.provider_code ?? '')) return '';
  const name = isRecord(found.parcelShop) ? text(found.parcelShop, 'name', 120) : '';
  return name && left.description!.toLocaleLowerCase('es').includes(name.toLocaleLowerCase('es')) ? name : '';
}

/**
 * The `found` shipment of `POST /expeditions/find`. The service looked the
 * whole number up with the postcode; the reply names the shipment it
 * resolved, which may hold the number as a parcel barcode or reference it does
 * not echo. Its addresses, the sender, the recipient and their document, the
 * point's collection code and the scans' reasons are never read.
 */
export function parseGLSSpain(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGLSSpainNumber(raw);
  const found = isRecord(payload) && isRecord(payload.found) ? payload.found : null;
  if (!found) throw new SchemaError(PROVIDER, 'GLS Spain returned an unexpected reply');
  const shipment = text(found, 'expeditionCode', 40);
  if (!/^\d{1,20}$/.test(shipment)) throw new SchemaError(PROVIDER, 'GLS Spain returned a shipment without its number');
  if (!isRecord(found.state)) throw new SchemaError(PROVIDER, 'GLS Spain returned a shipment without its state');
  const state = found.state;
  const stateCode = text(state, 'code', 64);
  const stateText = text(state, 'description');
  if (!stateCode) throw new SchemaError(PROVIDER, 'GLS Spain returned a shipment without its state');
  const rows = found.tracking ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'GLS Spain returned an invalid scan list');

  // The reply lists the scans newest first.
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const event = scan(row);
    const key = JSON.stringify([event.time, event.provider_code, event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  const newest = events[0];
  // The shipment's state is what the app heads its page with; the newest scan
  // of the same state reads the same, with its sentence.
  const current: ClassifiedWording | null = newest?.stage && newest.provider_code === stateCode
    ? { stage: newest.stage as ClassifiedWording['stage'], source: newest.stage_source! }
    : glsSpainStage(stateCode, stateText);
  const stage = current?.stage;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const point = pickupPoint(found, events, stage);
  const weight = isRecord(found.attributes) ? found.attributes.weight : undefined;
  const lastText = newest?.description ?? stateText;
  if (!lastText) throw new SchemaError(PROVIDER, 'GLS Spain returned a shipment without wording');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: lastText,
    last_update: newest?.time ?? null,
    expected_delivery: stage && !['delivered', 'returned'].includes(stage) ? estimatedDay(state) : null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 10_000 ? { weight_kg: weight } : {}),
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    ...(events.length ? {} : { provider_code: stateCode, summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The service's reply to a lookup. A 404 with its own not-found error is the
 * only missing shipment: no shipment has the number with that postcode. Any
 * other error reply leaves the answer open.
 */
export function parseGLSSpainReply(status: number, payload: unknown, raw: string): CarrierResult {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  if (status === 404) {
    if (error?.name === 'NotFoundError' && error.details === 'notFound' && !('found' in (payload as JsonObject))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'GLS Spain answered with an error instead of the shipment');
  }
  if (error) throw new IndeterminateError(PROVIDER, 'GLS Spain answered with an error instead of the shipment');
  return parseGLSSpain(payload, raw);
}
