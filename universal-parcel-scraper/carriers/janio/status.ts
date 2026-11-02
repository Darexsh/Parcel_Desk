import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Janio's status codes, which name the leg of the journey: the order, the
 * pickup, the origin country, the flight, the destination country and the
 * delivery. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ORDER_CREATED', 'registered'], // The order details, not the parcel.
  ['PENDING_PICKUP', 'registered'], // A pickup arranged with the sender.
  ['FAILED_PICKUP', 'registered'], // The pickup failed: the parcel is still with the sender.
  ['IN_TRANSIT_WITHIN_ORIGIN_COUNTRY', 'in_transit'], // At or between warehouses before the flight.
  ['CROSS_BORDER_TRANSIT', 'in_transit'], // The flight to the destination country.
  ['IN_TRANSIT_WITHIN_DESTINATION_COUNTRY', 'in_transit'], // At or between the delivery partner's facilities.
  ['DELIVERY_IN_PROGRESS', 'out_for_delivery'], // With the delivery partner's courier; a delivery follows within hours.
  ['DELIVERY_COMPLETED', 'delivered'],
]);

/** The stage Janio's codes give a status code. */
export function janioMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function janioStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = janioMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? janioMappedStage(code) : undefined),
  gaps: [],
};
