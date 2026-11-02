import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The action RedX files each scan under. Only actions seen in replies are
 * mapped; another action falls to the wording rules.
 */
const ACTIONS: ReadonlyMap<string, Stage> = new Map([
  ['pickup-pending', 'registered'], // The merchant booked the parcel and asked for a pickup.
  ['received-from-seller', 'accepted'], // Picked up from the merchant.
  ['dispatched-to-line-haul', 'in_transit'], // Waiting at a hub for the vehicle to the next one.
  ['trip-started', 'in_transit'], // The vehicle left the hub.
  ['bulk-dropped', 'in_transit'], // The vehicle reached the next hub; repeated for each bag.
  ['received-transfer', 'in_transit'], // Unloaded at the next hub.
  ['received-transit', 'in_transit'], // Sent on from a hub it only passed through.
  ['received-from-hub', 'in_transit'], // Received at a hub, the delivery hub included.
  ['received-area-change-approved-parcel', 'in_transit'], // The delivery area changed; the parcel moves to another hub.
  ['ready-for-delivery-by-bot', 'in_transit'], // Prepared again for delivery after a hold.
  ['ready-for-delivery-by-user', 'in_transit'], // Prepared again for delivery after a hold, by staff.
  ['dispatched-to-agent', 'out_for_delivery'], // With the rider.
  // Brought back to the hub after a delivery run, with the reason: the
  // customer could not be reached or asked for another day or place.
  ['agent-hold-returning', 'failed_attempt'],
  ['agent-delivered', 'delivered'],
  ['delivery-payment-collected', 'delivered'], // Delivered, with the cash on delivery collected.
]);

/** The stage RedX's action gives a scan. */
export function redxMappedStage(code: string): Stage | undefined {
  return ACTIONS.get(code.toLowerCase());
}

/** A scan's stage: its action, else the shared wording rules, else nothing. */
export function redxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? redxMappedStage(code) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? redxMappedStage(code) : undefined),
  gaps: [],
};
