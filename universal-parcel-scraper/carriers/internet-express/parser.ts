import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { HIDDEN_CODES, internetExpressStage, internetExpressWording } from './status.js';

export const PROVIDER = 'Internet Express';
/** Internet Express's provider id on Ship Logic, which the portal reads from `/providers` for its own host. */
export const SHIP_LOGIC_PROVIDER_ID = 9;
// A long history is a few kilobytes.
export const INTERNET_EXPRESS_MAX_BYTES = 512 * 1024;
// Waybill references and Ship Logic's six-character short references are letters and digits.
const NUMBER = /^[A-Z0-9]{5,40}$/;
const CODE = /^[a-z0-9-]{1,64}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A reference in capitals, as the portal's reply gives it back; anything else is not one Internet Express issues. */
export function normalizeInternetExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Internet Express references are five to forty letters and digits');
  return number;
}

function reference(value: unknown): string {
  return typeof value === 'string' ? clean(value, 64).toUpperCase() : '';
}

/** A status code; anything else is a changed reply. */
function code(value: unknown): string {
  if (typeof value !== 'string' || !CODE.test(value)) throw new SchemaError(PROVIDER, 'Internet Express returned an invalid status code');
  return value;
}

/** Ship Logic gives every clock in UTC with its `Z`; one without an offset is a changed reply. */
function instant(value: unknown): { iso: string; timestamp: number } {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) ? explicitOffsetTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Internet Express returned an invalid scan time');
  return parsed;
}

interface Scan { event: CarrierEvent; timestamp: number }

/** A shipment-level scan, or null for a piece's own scan or an event the portal hides. */
function scan(row: unknown): Scan | null {
  if (!isRecord(row) || !Number.isSafeInteger(row.parcel_id) || (row.parcel_id as number) < 0
    || (row.location != null && typeof row.location !== 'string')) throw new SchemaError(PROVIDER, 'Internet Express returned an invalid scan');
  const status = code(row.status);
  const clock = instant(row.date);
  // Scans with parcel_id 0 are the shipment's timeline, the one the portal
  // shows; one delivered piece does not deliver the shipment.
  if (row.parcel_id !== 0 || HIDDEN_CODES.has(status)) return null;
  const location = clean(row.location, 120);
  const stage = internetExpressStage(status);
  // The free-text message (driver SMS notices, staff remarks) is not kept.
  return { timestamp: clock.timestamp, event: {
    time: clock.iso, description: internetExpressWording(status), ...(location ? { location } : {}), provider_code: status,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * The reply of Ship Logic's `/tracking/shipments` for one reference on
 * Internet Express's portal. The shipment must belong to Internet Express and
 * carry the reference asked as its waybill or short reference.
 */
export function parseInternetExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeInternetExpressNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.shipments)) throw new SchemaError(PROVIDER, 'Internet Express returned an invalid envelope');
  // The portal says "Waybill not found" for an empty list, but the service
  // answers a reference it does not know with its own 404.
  if (!payload.shipments.length) throw new IndeterminateError(PROVIDER, 'Internet Express returned no shipment', { reason: 'portal_not_found' });
  if (payload.shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Internet Express matched several shipments');
  const shipment: unknown = payload.shipments[0];
  if (!isRecord(shipment) || shipment.provider_id !== SHIP_LOGIC_PROVIDER_ID) throw new SchemaError(PROVIDER, 'Internet Express answered for another courier');
  if (reference(shipment.custom_tracking_reference) !== number && reference(shipment.short_tracking_reference) !== number) {
    throw new IndeterminateError(PROVIDER, 'Internet Express answered for another shipment');
  }
  const summaryCode = code(shipment.status);
  const rows = shipment.tracking_events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Internet Express returned an invalid history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const read = scan(row);
    if (!read) continue;
    const key = JSON.stringify(read.event);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(read);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the clocks are instants, so a stable sort keeps the reply's order for equal ones.
  const events = scans.sort((a, b) => b.timestamp - a.timestamp).map((item) => item.event);

  // The portal shows the summary's status, and for a status it hides, the newest scan it shows.
  const current = HIDDEN_CODES.has(summaryCode) ? events[0]!.provider_code! : summaryCode;
  const stage: Stage | undefined = internetExpressStage(current);
  const newest = events[0]!;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const service = typeof shipment.service_level_name === 'string' ? clean(shipment.service_level_name, 80) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: internetExpressWording(current),
    ...(current !== newest.provider_code ? { provider_code: current } : {}),
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
