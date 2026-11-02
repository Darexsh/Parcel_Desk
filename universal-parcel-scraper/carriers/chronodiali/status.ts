import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Chronodiali's event types, as its Shipsy account reports them and the
 * tracking page's script keys its messages, in lower case. Another type falls
 * to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['softdata_upload', 'registered'], // The merchant's data reached Chronodiali.
  ['pickup_scheduled', 'registered'],
  ['pickup_awaited', 'registered'], // Created and waiting for the courier to collect it.
  ['pickup_completed', 'accepted'],
  ['inscan_at_hub', 'in_transit'],
  ['intransittohub', 'in_transit'],
  ['reachedathub', 'in_transit'],
  ['assigned_to_third_party', 'in_transit'],
  ['handover_to_third_party', 'in_transit'],
  ['arrived_in_country', 'in_transit'],
  ['pending_custom', 'customs'],
  // Cleared by customs, so back in transit.
  ['shipment_clear_successfully', 'in_transit'],
  ['on_hold', 'exception'],
  // Put on a delivery run at the destination hub.
  ['delivery_scheduled', 'in_transit'],
  // The courier took the parcel out on the run.
  ['accept', 'out_for_delivery'],
  ['outfordelivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['den001', 'failed_attempt'],
  ['den002', 'failed_attempt'],
  ['den003', 'failed_attempt'],
  ['den004', 'failed_attempt'],
  ['den005', 'failed_attempt'],
  ['den006', 'failed_attempt'],
  ['dex001', 'exception'], // Cancelled at the customer's request.
  ['dex002', 'exception'], // Damaged and not delivered.
  // A delivery moved to another run, date or address, with no attempt at the door.
  ['dex100', 'in_transit'],
  ['dex101', 'in_transit'],
  ['dex102', 'in_transit'],
  ['dex103', 'in_transit'],
  ['rescheduled', 'in_transit'],
  // Waiting at the hub for its next run.
  ['shelved', 'in_transit'],
  ['arrived_at_airport', 'in_transit'],
  // A pickup cancelled, so nothing was collected.
  ['pkx001', 'exception'],
  ['pkx002', 'exception'],
  ['pkx003', 'exception'],
  ['pkx004', 'exception'],
  ['pkx005', 'exception'],
  // A pickup moved or failed: the parcel still waits for the courier.
  ['pkx100', 'registered'],
  ['pkx101', 'registered'],
  ['pkx102', 'registered'],
  ['pkx103', 'registered'],
  ['pkn001', 'registered'],
  ['pkn002', 'registered'],
  ['pkn003', 'registered'],
  ['pkn004', 'registered'],
  ['pkn005', 'registered'],
  ['cancelled', 'exception'],
  // A return to the sender, started and then delivered back.
  ['rto', 'returned'],
  ['rto_delivered', 'returned'],
]);

/** The stage Chronodiali's own event types give a scan. */
export function chronodialiMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toLowerCase());
}

/** A scan's stage: its type, else the shared wording rules, else nothing. */
export function chronodialiStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = chronodialiMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? chronodialiMappedStage(code) : undefined),
  gaps: [],
};
