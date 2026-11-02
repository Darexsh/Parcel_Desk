import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Pandu Logistics' tracker, which carries no code. A branch
 * arrival names the branch after `PSS`. `received` is a delivery scan once the
 * parser has taken the receiver's name and the repeated clock out of it; the
 * summary's `delivered` stands over a delivered shipment.
 */
const STAGES: readonly (readonly [RegExp, Stage])[] = [
  [/^received at origin station$/, 'accepted'],
  [/^arrived at pss \S.*$/, 'in_transit'],
  [/^departed from origin$/, 'in_transit'],
  [/^delivery process by courier$/, 'out_for_delivery'],
  [/^received$/, 'delivered'],
  [/^delivered$/, 'delivered'],
];

/** The stage the map gives Pandu Logistics' wording, if it knows it. */
export function panduLogisticsMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function panduLogisticsStage(wording: string): ClassifiedWording | null {
  const mapped = panduLogisticsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : panduLogisticsMappedStage(wording)),
  gaps: [],
};
