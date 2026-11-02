import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Mylerz's consumer statuses (`StatusBusId`), the ones its tracker shows for
 * each scan. Its script's `ConsumerPackageStatusEnum` names 1 to 11, and
 * replies add 12 for an order the shipper uploaded. A code the map does not
 * know falls to the wording rules.
 */
const CODES: ReadonlyMap<number, Stage> = new Map([
  [1, 'exception'], // Cancelled by the shipper.
  [2, 'delivered'], // "Delivered, Enjoy it :-)".
  [3, 'in_transit'], // "In-Transit": received at a Mylerz hub.
  [4, 'out_for_delivery'], // "mylerz on the way": with the courier who delivers it.
  [5, 'registered'], // Not picked up from the shipper yet.
  [6, 'returned'], // On its way back to the shipper.
  [7, 'accepted'], // "Picked from shipper".
  [8, 'exception'], // The recipient is asked to contact the shipper.
  [9, 'failed_attempt'], // Rejected, for the reason the courier gives; the parcel goes out again or back.
  [10, 'returned'], // Returned to the shipper.
  [11, 'failed_attempt'], // A delivery that did not happen and will be tried again.
  [12, 'registered'], // "Uploaded": the shipper has registered the order.
]);

/** The stage Mylerz's consumer statuses give a provider code. */
export function mylerzMappedStage(code: string): Stage | undefined {
  return /^\d{1,4}$/.test(code) ? CODES.get(Number(code)) : undefined;
}

/** A scan's stage: its consumer status, else the shared wording rules, else nothing. */
export function mylerzStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = mylerzMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? mylerzMappedStage(code) : undefined),
  gaps: [],
};
