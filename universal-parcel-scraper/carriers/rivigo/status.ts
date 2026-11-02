import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of Rivigo's Zoom platform, from its tracking page's script:
 * the codes of the history's scans, and the consignment statuses its client
 * dashboard lists. A scan's `activity` is free wording, such as `Origin PC -
 * IN`; the code stages it, and other codes fall to the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DRAFTED', 'registered'], // A consignment note started in the client dashboard.
  ['CREATED', 'registered'], // Booked, unless its wording is `Pickup`.
  ['INTRANSIT_TO_OU', 'in_transit'], // On the way to an operating unit, a processing centre or branch.
  ['REACHED_AT_PICKUP_BRANCH_OFFICE', 'in_transit'],
  ['REACHED_AT_PICKUP_PROCESSING_CENTER', 'in_transit'],
  ['RECEIVED_AT_OU', 'in_transit'], // At an operating unit; the page calls the origin's `Received`, the destination's `Arrived`.
  ['LOADED', 'in_transit'], // Loaded on a vehicle; the page calls the first `Dispatched`.
  ['UNLOADED', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['AT_TRANSSHIPMENT_PROCESSING_CENTER', 'in_transit'],
  ['AT_TRANSSHIPMENT_BRANCH_OFFICE', 'in_transit'],
  ['RECEIVED_AT_DELIVERY_PROCESSING_CENTER', 'in_transit'],
  ['RECEIVED_AT_DELIVERY_BRANCH_OFFICE', 'in_transit'],
  ['OUT_FOR_DELIVERY', 'out_for_delivery'],
  ['UNDELIVERED', 'failed_attempt'], // A delivery attempt the page counts, with its reason.
  ['PARTIALLY_DELIVERED', 'in_transit'], // Some boxes delivered, the others delayed.
  ['DELIVERED_POD_PENDING', 'delivered'], // Delivered; the signed note is still to be uploaded.
  ['DELIVERED', 'delivered'],
]);

// The page names a booking or first leg `Pickup` when the consignment was collected from the consignor.
const COLLECTED = new Set(['CREATED', 'INTRANSIT_TO_OU']);
const PICKUP = normalizeStatusWording('Pickup');

/** The stage the map gives a scan's code and wording. */
export function rivigoMappedStage(code: string, wording: string): Stage | undefined {
  const key = code.toUpperCase();
  if (COLLECTED.has(key) && normalizeStatusWording(wording) === PICKUP) return 'accepted';
  return CODES.get(key);
}

/** A scan's stage: its code in the map, else the shared wording rules, else nothing. */
export function rivigoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = rivigoMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? rivigoMappedStage(code, wording) : undefined),
  gaps: [],
};
