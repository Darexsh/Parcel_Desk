import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Valmo's status codes: the steps of a history and the hub scans under them.
 * The track page's script names the step codes; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ORDER_CONFIRMED', 'registered'], // The seller's order is booked with Valmo.
  ['ORDER_READY_FOR_PICKUP', 'registered'], // Ready for Valmo to collect from the seller, not waiting for the buyer.
  ['ORDER_SHIPPED', 'accepted'], // Collected from the seller; the hub scans follow.
  ['ORDER_REACHED_HUB', 'in_transit'],
  ['ORDER_LEFT_HUB', 'in_transit'],
  ['ORDER_OUT_FOR_DELIVERY', 'out_for_delivery'],
  ['ORDER_DELIVERY_ATTEMPT_FAILED', 'failed_attempt'], // One attempt; another goes out.
  ['ORDER_DELIVERED', 'delivered'],
  // Delivery given up: the page marks it as a failure, and the parcel goes back to the seller.
  ['ORDER_DELIVERY_FAILED', 'exception'],
  ['ORDER_RETURNED_TO_SELLER', 'returned'],
  ['ORDER_CANCELLED', 'exception'],
  ['ORDER_LOST', 'exception'],
]);

/** The stage Valmo's codes give a status code. */
export function valmoMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function valmoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = valmoMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? valmoMappedStage(code) : undefined),
  // Every code seen has a stage.
  gaps: [],
};
