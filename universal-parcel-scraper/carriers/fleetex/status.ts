import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The feed's scans carry no code, only the platform's message for the scan's
 * event, with every word capitalized. The messages seen in replies and in the
 * API documentation are mapped, with the order statuses that documentation
 * lists; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Event 100, the order's details sent in by the shipper; the second for a parcel to collect.
  ['Your shipment information has been submitted.', 'registered'],
  ['Your parcel request has been received successfully.', 'registered'],
  ['We have received your package details and are processing your order.', 'registered'],
  // Events 301 and 300, the first scans at a FleetExpress depot.
  ['Your parcel has been collected and arrived at Distribution Centre.', 'accepted'],
  ['Your parcel has arrived safely at Distribution Centre.', 'accepted'],
  ['Your shipment is in transit.', 'in_transit'],
  ['Out For Delivery', 'out_for_delivery'],
  ['Your parcel has been delivered successfully. Thank you!', 'delivered'], // Event 500.
  // Order statuses of the client API.
  ['New', 'registered'],
  ['Received', 'accepted'],
  ['Already Pickuped', 'in_transit'],
  ['Successful', 'delivered'],
  ['Need Reschedule', 'failed_attempt'],
  ['Hold', 'exception'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's message. */
export function fleetexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its message in the map, else the shared wording rules, else nothing. */
export function fleetexStage(wording: string): ClassifiedWording | null {
  const mapped = fleetexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => fleetexMappedStage(wording),
  gaps: [],
};
