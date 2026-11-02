import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of ICS Courier's tracker. Rows carry no code. Some rows go on
 * after their opening: "Delivered at:" names the recipient and their address,
 * "Picked Up" the shipper, "At SMARTSpot for pickup" the point, "Delivery
 * Attempt:" the driver's reason, and branch rows name the branch. The parser
 * keeps the opening of the first three; the map reads either form.
 */
const RULES: readonly (readonly [RegExp, Stage])[] = [
  // A pre-advice from the shipper's label, before ICS has the parcel.
  [/^shipping label created$/, 'registered'],
  [/^picked up\b/, 'accepted'],
  [/^at ics branch \S.* for processing$/, 'in_transit'],
  [/^in transit$/, 'in_transit'],
  // Sorted at the delivering branch before it goes out.
  [/^in sort process$/, 'in_transit'],
  [/^out for delivery$/, 'out_for_delivery'],
  [/^delivery attempt\b/, 'failed_attempt'],
  // Left at a SMARTSpot, a shop or depot that holds parcels for collection.
  [/^at smartspot for pickup\b/, 'ready_for_pickup'],
  [/^delivered\b/, 'delivered'],
];

/** The stage the map gives ICS Courier's wording, if it knows it. */
export function icsCourierScanStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return RULES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function icsCourierStage(wording: string): ClassifiedWording | null {
  const mapped = icsCourierScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only, and every wording seen moves the parcel. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : icsCourierScanStage(wording)),
  gaps: [],
};
