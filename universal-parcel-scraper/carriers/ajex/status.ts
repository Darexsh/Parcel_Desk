import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * AJEX's scan codes. The older system numbers its statuses (`80`); the newer
 * one, behind the `A` numbers, names its events `AJ0011` and leaves the status
 * code at 0. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['100', 'registered'], // Shipment pickup scheduled: the shipper booked a pickup.
  ['54', 'accepted'], // Shipment picked up from the shipper.
  ['618', 'in_transit'], // Shipment scanned in a hub.
  ['50', 'in_transit'], // Shipment arrived at a hub.
  ['204', 'out_for_delivery'], // Shipment assigned to driver; the note says it is out for delivery.
  ['70', 'failed_attempt'], // Undelivered, with the reason in brackets.
  ['80', 'delivered'],
  ['AJ0001', 'registered'], // Booking Placed.
  ['AJ0002', 'registered'], // Booking Confirmed, also when the pickup is rescheduled.
  ['AJ0007', 'accepted'], // Shipment picked up.
  ['AJ0008', 'in_transit'], // Received at Hub.
  ['AJ0012', 'in_transit'], // In Transit: loaded for the destination.
  ['AJ0015', 'in_transit'], // DeliverySheet Created: put on a courier's delivery run.
  ['AJ0016', 'in_transit'], // In Transit: arrived at the destination.
  ['AJ0017', 'exception'], // Shipment Not Picked: the pickup failed and the parcel is still with its shipper.
  ['AJ0019', 'out_for_delivery'],
  ['AJ0026', 'exception'], // Hold at Terminal, until something such as a delivery appointment is settled.
  ['AJ0031', 'in_transit'], // Trip Exception: a line-haul delay; the parcel moves on.
  ['AJ0011', 'delivered'],
]);

/** The stage AJEX's codes give a scan code. */
export function ajexMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function ajexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = ajexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? ajexMappedStage(code) : undefined),
  gaps: [],
};
