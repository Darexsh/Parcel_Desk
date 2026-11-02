import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's status labels and the fixed sentences under them, current and
 * from the earlier page, whose table had a status and a details column and a
 * CN Status summary. A sentence that goes on with a name or a reason is read
 * by its label.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Booked', 'registered'],
  ['Your order has been placed. It will be packed and prepared for shipment.', 'registered'],
  ['Booking', 'registered'],
  ['Shipment is booked.', 'registered'],
  // Taken in at the origin hub.
  ['Arrived at OPS Facility', 'accepted'],
  ['The shipment has been arrived at M&P operations at the origin hub and will be scheduled for transit', 'accepted'],
  ['Arrived at OPS', 'accepted'],
  ['Shipment has arrived at origin facility.', 'accepted'],
  ['In-transit', 'in_transit'],
  ['The shipment has been dispatched and is on its way to the destination city', 'in_transit'],
  ['Loading', 'in_transit'],
  ['Shipment has departed.', 'in_transit'],
  ['LOADED', 'in_transit'],
  ['Reached at Destination', 'in_transit'],
  ['The shipment has been arrived at the destination city and will be scheduled for delivery', 'in_transit'],
  ['Unloading', 'in_transit'],
  ['Shipment has arrived at hub.', 'in_transit'],
  ['Out-for-Delivery', 'out_for_delivery'],
  ['On Delivery', 'out_for_delivery'],
  ['Shipment is Out for Delivery.', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Shipment has been Delivered.', 'delivered'],
  ['Unsuccessful Delivery Attempt', 'failed_attempt'],
  ['Refused Delivery', 'failed_attempt'],
  ['Shipment is undelivered as delivery was refused by consignee.', 'failed_attempt'],
  // Delivery stopped and the parcel is to go back to the shipper.
  ['Ready to Return', 'exception'],
  ['Shipment is undelivered due to Ready to Return.', 'exception'],
  ['Return to Shipper', 'returned'],
  ['Shipment has been Returned to Shipper.', 'returned'],
  ['RETURNED', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a label or sentence, read case-insensitively. */
export function mAndPMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its label's, else its sentence's, else the shared wording rules', else nothing. */
export function mAndPStage(label: string, sentence: string): ClassifiedWording | null {
  const mapped = (label ? mAndPMappedStage(label) : undefined) ?? (sentence ? mAndPMappedStage(sentence) : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [label, sentence]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? mAndPMappedStage(code) : undefined) ?? mAndPMappedStage(wording),
  gaps: [],
};
