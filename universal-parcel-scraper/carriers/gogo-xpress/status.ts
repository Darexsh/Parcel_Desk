import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GoGo Xpress's status codes, the `status` of each scan and of the shipment.
 * The codes seen in replies come first, then those the web app's own status
 * filters group, which no reply has shown yet. Another code falls to the
 * shared rules on its `status_name`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['for_pickup', 'registered'], // Booked; the remark gives the pickup day, or why the rider did not come.
  ['pickup_rider_found', 'registered'],
  ['out_for_pickup', 'registered'], // The rider is on the way to the merchant.
  ['failed_pickup_attempt', 'exception'], // The rider could not collect the parcel.
  ['failed_pickup', 'exception'], // The pickup was closed without the parcel.
  ['canceled', 'exception'], // The booking was cancelled.
  ['picked_up', 'accepted'],
  ['received_at_pickup_hub', 'in_transit'],
  ['at_sorting_center', 'in_transit'],
  ['in_transit', 'in_transit'], // Line hauls, and the scans of a delivery partner relayed as they are.
  ['for_transfer', 'in_transit'], // Handed to a delivery partner for the last leg.
  ['received_at_delivery_area', 'in_transit'],
  ['received_at_delivery_hub', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['failed_delivery', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['rider_found', 'registered'],
  ['picking_up', 'registered'],
  ['for_dropoff', 'registered'], // The merchant brings the parcel to a hub.
  ['dropped_off', 'accepted'],
  ['dws_update', 'in_transit'], // A weighing at the sorting centre, which the page shows as one.
  ['transferred_to_partner', 'in_transit'],
  ['for_consolidation', 'in_transit'],
  ['consolidated', 'in_transit'],
  ['for_acceptance', 'in_transit'],
  ['accepted', 'in_transit'],
  ['for_release', 'in_transit'],
  ['for_return', 'returned'],
  ['out_for_return', 'returned'],
  ['return_in_transit', 'returned'],
  ['arrived_at_rts_hub', 'returned'],
  ['arrived_at_rts_area', 'returned'],
  ['at_sorting_center_rts', 'returned'],
  ['returned', 'returned'],
  ['failed_return', 'exception'],
]);

/**
 * The claims and disposal codes. The page hides their scans and shows the
 * shipment as needing action, so the adapter skips the scans and reads the
 * shipment's code as an exception.
 */
export const GOGO_XPRESS_CLAIMS: ReadonlySet<string> = new Set([
  'lost', 'for_claims', 'rejected', 'claims_in_transit', 'arrived_at_claims_area', 'claimed', 'for_disposal',
  'pending_disposition', 'disposed', 'rcd_in_transit', 'rcd_at_sorting_center', 'received_at_claims_recovery_hub',
]);

/** The stage GoGo Xpress's codes give a status code. */
export function gogoXpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toLowerCase());
}

/** A scan's stage: its code, else the shared wording rules on its status name, else nothing. */
export function gogoXpressStage(code: string, name: string): ClassifiedWording | null {
  const mapped = gogoXpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The stage the shipment's own code settles over its scans: an end, a failure or a claim. */
export function gogoXpressSummaryStage(code: string): Stage | undefined {
  if (GOGO_XPRESS_CLAIMS.has(code.toLowerCase())) return 'exception';
  const mapped = gogoXpressMappedStage(code);
  return mapped === 'delivered' || mapped === 'returned' || mapped === 'exception' ? mapped : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? gogoXpressMappedStage(code) : undefined),
  gaps: [],
};
