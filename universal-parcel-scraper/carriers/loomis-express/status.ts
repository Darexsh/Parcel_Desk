import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case, single spaces and straight apostrophes. */
function key(wording: string): string {
  return normalizeStatusWording(wording.replace(/[‘’]/g, "'"));
}

/**
 * The scan wordings Loomis Express's tracker shows, whole. They are the
 * descriptions of TransForce's scan codes, which Canpar's tracker words the
 * same way. A failed pickup leaves the parcel with its shipper, so it is still
 * only registered. "Arrived at Terminal" and "Sort Through Facility" are older
 * wordings of the arrival and sort scans.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['shipment record received', 'registered'],
  ["couldn't pick it up-trying again soon", 'registered'],
  ['picked up and on the move!', 'accepted'],
  ['package has arrived at our facility', 'in_transit'],
  ['arrived at terminal', 'in_transit'],
  ['sorting it out-stay tuned!', 'in_transit'],
  ['sort through facility', 'in_transit'],
  ['departing sort facility', 'in_transit'],
  ['out for delivery-almost there!', 'out_for_delivery'],
  ["can't find the address-checking again!", 'failed_attempt'],
]);

// Delivery wordings name the way the parcel was left after these words, cut
// short ("with no Signa") and sometimes followed by where it was left.
const DELIVERED = /^(?:your|our) package was delivered(?: |$)/;

/** The estimated delivery day, which the page lists as the newest row. */
export const ESTIMATE_WORDING = 'Estimated Delivery Date';

/** The stage the map gives a scan's wording, if it knows it. */
export function loomisScanStage(wording: string): Stage | undefined {
  const text = key(wording);
  return SCANS.get(text) ?? (DELIVERED.test(text) ? 'delivered' : undefined);
}

/** Whether a row is the estimated delivery day rather than a scan. */
export function loomisEstimate(wording: string): boolean {
  return key(wording) === key(ESTIMATE_WORDING);
}

/** A scan's stage from the map, else from the shared wording rules; wording neither knows has none. */
export function loomisStage(wording: string): ClassifiedWording | null {
  const mapped = loomisScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page shows wording only, without the scan codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : loomisScanStage(wording)),
  gaps: [{ wording: key(ESTIMATE_WORDING), note: 'The estimated delivery day, kept as the estimate; it is not a scan.' }],
};
