import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The opening words of Jetline's history rows, which carry no code. A branch
 * or a route follows them. Other wording, such as a delivery run's outcome
 * after "SHIPMENT CURRENT STATUS IS", goes to the shared wording rules.
 */
const OPENINGS: readonly (readonly [string, Stage])[] = [
  // Booked at the branch that took the parcel.
  ['booked at', 'accepted'],
  // Sent on from a branch to the next one; the tracker spells it "DESTIANTION".
  ['shipment dispatch for destiantion', 'in_transit'],
  ['shipment dispatch for destination', 'in_transit'],
  // Received at a branch on the way, the destination's included. The shared rules read "received" as an acceptance.
  ['shipment received at', 'in_transit'],
];
const DELIVERED = 'shipment current status is delivered';

/** The stage the map gives Jetline's wording, if it knows it. */
export function jetlineMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (normalized === DELIVERED) return 'delivered';
  return OPENINGS.find(([opening]) => normalized === opening || normalized.startsWith(`${opening} `))?.[1];
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function jetlineStage(wording: string): ClassifiedWording | null {
  const mapped = jetlineMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : jetlineMappedStage(wording)),
  gaps: [],
};
