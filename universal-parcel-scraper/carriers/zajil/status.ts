import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The `website_update` values of Zajil's tracking lookup, which its page puts
 * on a three-step rail (Processing, In Transit, Delivered), with the stage each
 * means. The page names every value here; `delivered` and `In_Transit` were
 * seen in replies too.
 */
const UPDATES: ReadonlyMap<string, Stage> = new Map([
  ['processing', 'registered'], // The rail's first step: booked, not moving yet.
  ['pickup_scheduled', 'registered'], // A collection is booked; the parcel is still with the shipper.
  ['pickup_completed', 'accepted'],
  ['In_Transit', 'in_transit'],
  ['arrived', 'in_transit'], // At a branch or hub on the way.
  ['out_for_delviery', 'out_for_delivery'], // Zajil's own spelling.
  ['undelivered', 'failed_attempt'],
  ['recheduled', 'failed_attempt'], // A delivery moved to another day, Zajil's own spelling.
  ['ready_for_collection', 'ready_for_pickup'],
  ['delivered', 'delivered'],
  ['returned_to_shipper', 'returned'],
  ['rejected_by_customer', 'exception'], // Refused by the recipient.
  ['cancelled', 'exception'],
  ['Hold', 'exception'],
]);

/** The stage Zajil's `website_update` value gives a status. */
export function zajilMappedStage(code: string): Stage | undefined {
  return UPDATES.get(code);
}

/** A status's stage: its `website_update` value, else the shared wording rules, else nothing. */
export function zajilStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = zajilMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? zajilMappedStage(code) : undefined),
  gaps: [],
};
