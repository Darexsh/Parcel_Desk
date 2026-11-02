import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * RPX's tracking codes. Only codes seen in replies are mapped; another code
 * falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The shipper booked the parcel: "Shipping Manifest Accepted and Waiting For
  // Pickup", or "Your order is still on packing process by Shipper/Seller".
  ['WPU', 'registered'],
  ['PUP', 'accepted'], // Picked Up.
  ['MDE', 'in_transit'], // Manifesting Package, at the origin station after the pickup.
  ['SOP', 'in_transit'], // Departed from RPX Origin station.
  ['POD', 'delivered'], // Shipment received by Consignee.
]);

/** The stage RPX's codes give a scan code. */
export function rpxMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function rpxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = rpxMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? rpxMappedStage(code) : undefined),
  gaps: [],
};
