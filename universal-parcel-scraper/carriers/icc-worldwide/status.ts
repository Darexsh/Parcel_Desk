import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of ICC Worldwide's tracking page, which carries no code. The map
 * holds the summary's own line for a delivered shipment; the rows' details are
 * the checkpoints' free text and go to the shared wording rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['shipment delivered', 'delivered'],
]);

/** The stage the map gives ICC Worldwide's wording, if it knows it. */
export function iccWorldwideMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's or the summary's stage from the map, else from the shared wording
 * rules. Wording neither knows stays without a stage, so it remains visible
 * for review.
 */
export function iccWorldwideStage(wording: string): ClassifiedWording | null {
  const mapped = iccWorldwideMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : iccWorldwideMappedStage(wording)),
  gaps: [],
};
