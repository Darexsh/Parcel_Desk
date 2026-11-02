import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Geniki Taxydromiki's checkpoint codes, the same in Greek and English. The
 * wordings come from the tracker's replies. C_SC and C_S2 come only from the
 * tracking page's own code, which files C_SC with C_NW as a voucher the
 * customer created and C_S2 with the deliveries. The shared wording rules
 * leave several of them unstaged, such as a collected parcel.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The customer created the voucher and printed its label.
  ['C_NW', 'registered'],
  ['C_SC', 'registered'],
  // A courier collected the parcel from its sender.
  ['C_W3', 'accepted'],
  // A service point registered the shipment it was handed: the page shows its
  // date as the collection by Geniki and hides the customer's voucher step.
  ['C_KK', 'accepted'],
  // Departures from a service point, arrivals and departures at hubs, arrivals
  // at a service point and a routing on to another one.
  ['C_K8', 'in_transit'],
  ['C_H1', 'in_transit'],
  ['C_H2', 'in_transit'],
  ['C_A1', 'in_transit'],
  ['C_L1', 'in_transit'],
  // Handed to a courier for delivery ("Χρέωση σε κούριερ").
  ['C_A3', 'out_for_delivery'],
  ['C_W2', 'delivered'],
  // The delivery recorded at the service point, with the parcel marked delivered.
  ['C_P1', 'delivered'],
  ['C_S2', 'delivered'],
]);

/** The stage of one checkpoint code, if the map gives it one. */
export function genikiStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/**
 * What the map says about one scan. Every scan carries its code, so wording
 * alone gets nothing. The page's error codes (C_EA_*), cancellations (C_E2,
 * C_L2, C_K9, C_P4, C_S5, C_S8) and the other codes it counts as in progress
 * have no wording any source settles, so they stay unknown, open for review.
 */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? genikiStage(code) : undefined),
  gaps: [],
};
