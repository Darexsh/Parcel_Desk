import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scans and its current status carry wording only, in capitals:
 * a move between branches, the arrival at the destination branch and the
 * delivery. The adapter words the booking `Booked`. Only wording seen on the
 * current tracker is mapped; other wording, such as the former tracker's,
 * falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['booked', 'accepted'],
  ['in-transit', 'in_transit'],
  // The page does not say whether the parcel waits there for collection or goes out to the door.
  ['arrived at destination', 'in_transit'],
  ['delivered', 'delivered'],
]);

/** The stage the map gives a wording, if it knows it. */
export function vrlMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A wording's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function vrlStage(wording: string): ClassifiedWording | null {
  const mapped = vrlMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : vrlMappedStage(wording)),
  gaps: [],
};
