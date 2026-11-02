import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Micro Express's event codes, in upper case. The tracking page calls a
 * parcel delivered when its newest scan is `DOWN` and in transit otherwise.
 * Only codes seen in replies, or that the courier app sends, are mapped;
 * another falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The shipper submitted the order; Micro Express does not have the parcel yet.
  ['INIT', 'registered'],
  // Processed at the sorting facility, the first scan of the parcel itself.
  ['IN', 'in_transit'],
  // Received at the local delivery depot.
  ['COLLECT', 'in_transit'],
  // On board the courier's vehicle for delivery.
  ['OUT', 'out_for_delivery'],
  ['DOWN', 'delivered'],
  // The courier app's record of a collection shop handing the parcel to its recipient.
  ['SELF-PICK', 'delivered'],
]);

// The courier app's wording for a parcel left at a collection shop, which the
// recipient collects there later.
const SHOP = /^delivered by store\b/i;

/** The stage Micro Express's codes give an event code. */
export function microExpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: a delivery to a collection shop, its code, else the shared wording rules, else nothing. */
export function microExpressStage(code: string, wording: string): ClassifiedWording | null {
  if (SHOP.test(wording)) return { stage: 'ready_for_pickup', source: 'carrier_map' };
  const mapped = microExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (SHOP.test(wording) ? 'ready_for_pickup' : code ? microExpressMappedStage(code) : undefined),
  gaps: [],
};
