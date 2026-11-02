import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { classifyWording } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ekartScan } from './status.js';

const PROVIDER = 'Ekart';
export function normalizeEkartNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z]{4}\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Ekart requires an ecommerce tracking ID');
  return number;
}

export function parseEkart(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEkartNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  const keys = Object.keys(payload);
  // An empty object is Ekart's answer for a number it does not know: inconclusive, but not an outage.
  if (!keys.length) throw new IndeterminateError(PROVIDER, 'Ekart returned no tracking history', { reason: 'portal_not_found' });
  if (keys.length !== 1 || normalizeTrackingNumber(keys[0]!) !== number || !isRecord(payload[keys[0]!])) {
    throw new SchemaError(PROVIDER, 'Ekart returned a different or ambiguous shipment');
  }
  const shipment = payload[keys[0]!] as Record<string, unknown>;
  if (!Array.isArray(shipment.shipmentTrackingDetails) || shipment.shipmentTrackingDetails.length > 1000) throw new SchemaError(PROVIDER);
  if (!shipment.shipmentTrackingDetails.length) throw new IndeterminateError(PROVIDER, 'Ekart returned no tracking history');
  // The official client uses the last source row as current: its history
  // is oldest first. Keep that evidence even when a scan clock is unresolved.
  const history: unknown[] = shipment.shipmentTrackingDetails;
  let returning = false;
  const events: CarrierEvent[] = history.map(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Ekart returned an invalid scan');
    const description = clean(row.statusDetails, 1000);
    if (!description) throw new SchemaError(PROVIDER, 'Ekart returned a scan with no description');
    // The website passes these values to new Date() as epoch milliseconds.
    const time = typeof row.date === 'number' && Number.isSafeInteger(row.date) && row.date >= 1_000_000_000_000
      ? epochMillisTime(row.date)?.iso : undefined;
    const scan = ekartScan(description);
    // An RTO scan puts itself and every later scan on the way back to the seller.
    returning ||= scan.returning;
    const mapped = scan.stage ? { stage: scan.stage, source: 'carrier_map' } : classifyWording(description, 'pending');
    // A delivery on the return leg reaches the seller, not the recipient.
    const classified = returning && mapped.stage === 'delivered' ? { stage: 'returned', source: 'carrier_map' } : mapped;
    const location = clean(row.city, 200);
    return { description, ...(time ? { time } : cleanScalar(row.date, 64) ? { provider_time_text: cleanScalar(row.date, 64) } : {}),
      ...(location ? { location } : {}), ...(classified.source !== 'none' ? { stage: classified.stage, stage_source: classified.source } : {}),
      ...(scan.code ? { provider_code: scan.code } : {}), ...(returning ? { provider_leg: 'return' } : {}) };
  }).reverse();
  const unique = events.filter((row, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(row)) === index);
  const latest = unique[0]!;
  const status: CarrierStatus = latest.stage === 'delivered' ? 'delivered' : latest.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['returned', 'exception', 'failed_attempt'].includes(latest.stage ?? '') ? 'exception'
      : ['registered', 'pending'].includes(latest.stage ?? '') ? 'pending' : latest.stage ? 'in_transit' : 'unknown';
  // The website shows the estimate until a delivery row exists. A return or
  // a cancelled pickup ends the outward delivery it estimated.
  const active = !returning && !['delivered', 'returned', 'exception'].includes(latest.stage ?? '');
  const eta = active && typeof shipment.expectedDeliveryDate === 'number' && shipment.expectedDeliveryDate >= 1_000_000_000_000
    ? epochMillisTime(shipment.expectedDeliveryDate)?.iso : undefined;
  return { status, last_status_text: latest.description, last_update: latest.time ?? null, timezone: 'Asia/Kolkata',
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    ...(status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(eta ? { expected_delivery: eta } : {}), events: unique.slice(0, 100) };
}
