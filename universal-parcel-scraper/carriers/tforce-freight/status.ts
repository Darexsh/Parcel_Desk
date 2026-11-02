import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The activities of a shipment's history, in `normalizeStatusWording` form.
 * The driver picks the freight up at the shipper's, and it moves between
 * service centers until the one that delivers. A delivery appointment, and the
 * email asking the consignee for one, come before the delivery run. The UPS
 * Freight wording is the tracker's from before the rename.
 */
const ACTIVITIES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['shipment has been picked-up.', 'accepted'],
  ['shipment is at a tforce freight location', 'in_transit'],
  ['shipment is at a ups freight location', 'in_transit'],
  ['departure', 'in_transit'],
  ['shipment has arrived at a service center.', 'in_transit'],
  ['a delivery appointment has been scheduled with the consignee.', 'in_transit'],
  ['sent email. tforce freight is attempting to obtain appointment information', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['shipment has been delivered to the consignee.', 'delivered'],
]);

// "Shipment not delivered.", followed by the reason and when the driver comes back.
const NOT_DELIVERED = 'shipment not delivered.';

/**
 * The shipment's status, which the tracker shows beside the PRO and above the
 * progress bar. "On Vehicle For Delivery" is the former UPS Freight tracker's.
 * The events its update emails offer are no statuses it shows.
 */
const SHIPMENT: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['in transit', 'in_transit'],
  ['on vehicle for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The tracker's status for a PRO it has no shipment for. */
export const NOT_AVAILABLE = 'not available';

/** The stage TForce Freight's own list gives an activity. */
export function tforceFreightActivityStage(activity: string): Stage | undefined {
  const wording = normalizeStatusWording(activity);
  return ACTIVITIES.get(wording) ?? (wording.startsWith(NOT_DELIVERED) ? 'failed_attempt' : undefined);
}

/** The stage a shipment status gives, if the map knows one. */
export function tforceFreightShipmentStage(status: string): Stage | undefined {
  return SHIPMENT.get(normalizeStatusWording(status));
}

/** An activity's stage from the map, else from the shared wording rules; null when neither knows it. */
export function tforceFreightStage(activity: string): ClassifiedWording | null {
  const mapped = tforceFreightActivityStage(activity);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(activity, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one activity or shipment status, by its wording: the tracker has no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tforceFreightActivityStage(wording) ?? tforceFreightShipmentStage(wording)),
  gaps: [{ wording: NOT_AVAILABLE, note: 'The tracker\'s status for a PRO it has no shipment for, which the adapter reads as not found.' }],
};
