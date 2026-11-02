import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * ShipBlu's order statuses, as its API documentation lists them. A return
 * order travels from the customer to the merchant, so its arrival there is
 * `returned`, as on an order sent back.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['created', 'registered'],
  ['pickup_requested', 'registered'], // The merchant asked ShipBlu to collect the order.
  ['pickup_rescheduled', 'registered'],
  ['out_for_pickup', 'registered'], // A courier on the way to the merchant.
  ['return_requested', 'registered'], // The merchant asked ShipBlu to collect a return from the customer.
  ['picked_up', 'accepted'],
  ['in_transit', 'in_transit'], // At a ShipBlu warehouse.
  ['en_route', 'in_transit'], // Between two warehouses.
  ['out_for_delivery', 'out_for_delivery'],
  ['delivery_attempted', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['return_to_origin', 'returned'], // Refused, badly packed or out of zone: it goes back to the merchant.
  ['out_for_return', 'returned'], // A courier taking it to the merchant.
  ['return_postponed', 'returned'], // The merchant moved the return to the next day.
  ['returned', 'returned'],
  ['return_refused', 'exception'], // The merchant refused to take it back.
  ['cancelled', 'exception'], // Cancelled by the merchant before pickup.
]);

/** Codes the map leaves without a stage on purpose. */
const GAPS: ReadonlyMap<string, string> = new Map([
  ['return_attempted', 'A courier could not collect a return from the customer; the parcel is not in ShipBlu\'s hands yet.'],
]);

/** The stage ShipBlu's map gives a status code. */
export function shipbluMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The wording of a status code, as `out_for_delivery` reads "Out for delivery". */
export function shipbluWording(code: string): string {
  const words = code.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A scan's stage: the map, else the shared wording rules for a code the map does not know, else nothing. */
export function shipbluStage(code: string): ClassifiedWording | null {
  const mapped = shipbluMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(code)) return null;
  const classified = classifyWording(shipbluWording(code), 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code === null ? undefined : shipbluMappedStage(code)),
  gaps: [...GAPS].map(([code, note]) => ({ code, note })),
};
