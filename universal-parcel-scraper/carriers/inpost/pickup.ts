import { SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { inpostClock } from './clock.js';

const READY = new Set(['ready_to_pickup', 'ready_to_pickup_from_pok']);

/** Enrich collection histories only; a planned destination is not a pickup point. */
export function needsInpostPickup(result: CarrierResult): boolean {
  if (result.current_stage === 'ready_for_pickup') return true;
  if (result.current_stage !== 'delivered') return false;
  const events = result.events ?? [];
  const delivered = events.findIndex(event => event.stage === 'delivered');
  return delivered >= 0 && lastMovement(events.slice(delivered + 1)) === 'ready_for_pickup';
}

/** ShipX supplies point details only: hub status, scans and clocks remain authoritative. */
export function parseInpostPickup(payload: unknown, number: string, history: CarrierResult): string | undefined {
  if (!isRecord(payload) || typeof payload.tracking_number !== 'string'
    || payload.tracking_number.toUpperCase().replace(/[\s.-]/g, '') !== number) {
    throw new SchemaError('InPost pickup', 'InPost pickup details did not identify the requested shipment');
  }
  if (!needsInpostPickup(history)) return undefined;
  if (typeof payload.service !== 'string' || !/^inpost_locker_[a-z_]+$/.test(payload.service)) return undefined;
  if (!Array.isArray(payload.tracking_details) || payload.tracking_details.length > 500 || !payload.tracking_details.every(isRecord)) {
    throw new SchemaError('InPost pickup');
  }
  const scans = payload.tracking_details;
  const newest = scans[0];
  const sourceClock = inpostClock(newest?.datetime);
  const hubClock = inpostClock(history.last_update);
  // A point from an older or differently progressed source may precede a redirect.
  if (!newest || !sourceClock || !hubClock || sourceClock.timestamp < hubClock.timestamp || newest.status !== payload.status) return undefined;
  if (history.current_stage === 'ready_for_pickup') {
    if (typeof payload.status !== 'string' || !READY.has(payload.status)) return undefined;
  } else {
    if (payload.status !== 'delivered') return undefined;
    // Unknown movements leave collection uncertain; notices do not move a parcel.
    const beforeDelivery = scans.slice(1).find(scan => !['delivered', 'confirmed'].includes(String(scan.status)));
    if (!beforeDelivery || typeof beforeDelivery.status !== 'string' || !READY.has(beforeDelivery.status)) return undefined;
  }
  const attributes = payload.custom_attributes;
  if (!isRecord(attributes) || !isRecord(attributes.target_machine_detail)) return undefined;
  const point = attributes.target_machine_detail;
  if (!Array.isArray(point.type) || !point.type.some(type => ['parcel_locker', 'pok', 'pop'].includes(String(type)))) return undefined;
  const name = clean(point.name, 80);
  if (!name || (attributes.target_machine_id != null && attributes.target_machine_id !== point.name)) return undefined;
  const address = isRecord(point.address) ? point.address : {};
  return [name, clean(address.line1, 200), clean(address.line2, 200)].filter(Boolean).join('\n');
}
