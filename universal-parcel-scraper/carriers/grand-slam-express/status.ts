import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The opening words of Grand Slam Express's history rows, which carry no code.
 * The next branch and a manifest or challan number can follow them. Other
 * wording, such as the delivery round and the delivery, goes to the shared
 * wording rules.
 */
const OPENINGS: readonly (readonly [string, Stage])[] = [
  // Put on a manifest, then dispatched under a challan, to the next branch.
  ['packet manifested to', 'in_transit'],
  ['packet dispatched to', 'in_transit'],
  // Received at a branch, the destination's included.
  ['packet received', 'in_transit'],
  // Held by customs on arrival.
  ['custom hold', 'customs'],
];

/** The stage the map gives Grand Slam Express's wording, if it knows its opening words. */
export function grandSlamMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return OPENINGS.find(([opening]) => normalized === opening || normalized.startsWith(`${opening} `))?.[1];
}

/**
 * A row's or the heading's stage from the map, else from the shared wording
 * rules. Wording neither knows stays without a stage, so it remains visible
 * for review.
 */
export function grandSlamStage(wording: string): ClassifiedWording | null {
  const mapped = grandSlamMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : grandSlamMappedStage(wording)),
  gaps: [],
};
