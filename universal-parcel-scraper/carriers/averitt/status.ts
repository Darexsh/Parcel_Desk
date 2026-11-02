import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Averitt's tracking page: the status over the page, and each
 * row of its shipment progression. Neither carries a code.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The page's status once the freight is collected; the row says it in full.
  ['picked up', 'accepted'],
  ['shipment picked up', 'accepted'],
  ['origin departure', 'in_transit'],
  ['relay arrival', 'in_transit'],
  ['relay departure', 'in_transit'],
  ['destination arrival', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // Back at the delivering terminal, after a run that did not deliver as well
  // as on arrival: it says where the freight is, not that a delivery failed.
  ['at destination terminal', 'in_transit'],
  ['delivered', 'delivered'],
]);

/** The stage the map gives Averitt's wording, if it knows it. */
export function averittMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's or the page status's stage from the map, else from the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function averittStage(wording: string): ClassifiedWording | null {
  const mapped = averittMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : averittMappedStage(wording)),
  gaps: [],
};
