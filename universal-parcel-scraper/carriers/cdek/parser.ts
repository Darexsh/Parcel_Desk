import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cdekStage } from './status.js';

export const PROVIDER = 'CDEK';
// An order's reply, with its offices and their opening hours, is about ten kilobytes.
export const CDEK_MAX_BYTES = 512_000;

const MAX_MILESTONES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
// The order numbers CDEK issues.
const ORDER = /^\d{10,11}$/;
const ISSUED = /^\d{5,20}$/;

/** The service's own answers when it has no order to show. */
export const CDEK_ERRORS = {
  notFound: 'tracing.cant_determine_order',
  limit: 'tracing.tracking_limit_exceeded',
  later: 'tracing.universal_tracking.try_again_later',
  short: 'tracing.local_validation_5_symbols',
  long: 'tracing.local_validation_40_symbols',
} as const;

/**
 * CDEK's tracker takes 5 to 40 letters and digits, as its app checks them: its
 * own order numbers, and other numbers it links to an order, such as the
 * international postal number of a parcel from abroad.
 */
export function normalizeCdekNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^[A-Z0-9]{5,40}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'CDEK tracks numbers of 5 to 40 letters and digits');
}

/** The code of the service's error reply, `{"code": "tracing.…", "message": "…"}`. */
export function cdekErrorCode(payload: unknown): string {
  return isRecord(payload) ? clean(payload.code, 100) : '';
}

interface Scan { readonly event: CarrierEvent; readonly at: number; readonly index: number }

function scanOf(code: string, wording: unknown, clock: unknown, place: string, index: number): Scan | null {
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'CDEK returned an invalid status code');
  const at = explicitOffsetTime(clock);
  if (!at) return null;
  const stage = cdekStage(code);
  return {
    at: at.timestamp,
    index,
    event: { time: at.iso, description: clean(wording, 300) || code, provider_code: code, ...(place ? { location: place } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
  };
}

/**
 * The tracking service's reply for one order: its number and its milestones
 * in order, each with a code, Russian wording and a UTC clock, and the scans
 * within each milestone grouped by the city they happened in. Milestones the
 * order has not reached yet are listed too, marked as future, and are left
 * out. A milestone without scans, such as the delivery, is an event of its
 * own. The recipient's initials, the addresses, offices, phones, pickup codes
 * and the milestones' comments are never read.
 */
export function parseCdek(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCdekNumber(raw);
  if (!isRecord(payload) || typeof payload.type !== 'string') throw new SchemaError(PROVIDER, 'CDEK returned an unexpected reply');
  // Another service's number, which the app shows on that service's own tracking.
  if (payload.type !== 'CDEK') throw new IndeterminateError(PROVIDER, 'CDEK answered with tracking from another service');
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'CDEK did not return an order');
  const order = returnedTrackingNumber(data.orderNumber);
  const outer = payload.orderNumber === undefined ? order : returnedTrackingNumber(payload.orderNumber);
  if (!ISSUED.test(order) || outer !== order) throw new SchemaError(PROVIDER, 'CDEK returned an order without its number');
  // CDEK finds an order by a number it links to it and answers with the order's own number.
  if (order !== number && ORDER.test(number)) throw new SchemaError(PROVIDER, 'CDEK answered for a different order');

  const milestones = data.trackingDetails;
  if (!Array.isArray(milestones) || milestones.length > MAX_MILESTONES) throw new SchemaError(PROVIDER, 'CDEK returned an invalid order history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let rows = 0;
  const keep = (scan: Scan | null) => {
    if (!scan) return;
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  };
  for (const milestone of milestones) {
    if (!isRecord(milestone)) throw new SchemaError(PROVIDER, 'CDEK returned an invalid milestone');
    if (milestone.future === true) continue;
    const code = clean(milestone.code, 60);
    const cities = milestone.statuses ?? [];
    if (!Array.isArray(cities)) throw new SchemaError(PROVIDER, 'CDEK returned an invalid milestone');
    let inside = 0;
    for (const city of cities) {
      if (!isRecord(city) || !Array.isArray(city.cityChangelist)) throw new SchemaError(PROVIDER, 'CDEK returned an invalid city in its history');
      // The city's name; a scan before the order reached CDEK has none.
      const place = isRecord(city.city) ? clean(city.city.name, 120) : '';
      for (const row of city.cityChangelist) {
        if (!isRecord(row) || ++rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'CDEK returned an invalid scan');
        const scan = scanOf(clean(row.code, 60), row.name, row.timestamp, place, rows);
        if (!scan) throw new SchemaError(PROVIDER, 'CDEK returned a scan without its clock');
        keep(scan);
        inside += 1;
      }
    }
    // A milestone without scans is the event itself.
    if (!inside) keep(scanOf(code, milestone.name, milestone.timestamp, '', ++rows));
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the reply lists them oldest first, so equal clocks keep its order, reversed.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(scan => scan.event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: newest.time! } : {}),
    ...(order !== number ? { canonical_tracking_number: order } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
