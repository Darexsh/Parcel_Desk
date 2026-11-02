import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The opening words of Maruti Air's tracking rows, which carry no code. A
 * branch follows them, as in "Received at" and a city. Other wording goes to
 * the shared wording rules.
 */
const OPENINGS: readonly (readonly [string, Stage])[] = [
  // At a branch on the way, the destination's included.
  ['received at', 'in_transit'],
  // Sent on from a branch to the next one.
  ['forwarded to', 'in_transit'],
];

/** The stage the map gives Maruti Air's wording, if it knows its opening words. */
export function marutiAirMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return OPENINGS.find(([opening]) => normalized === opening || normalized.startsWith(`${opening} `))?.[1];
}

/**
 * A row's or the summary's stage from the map, else from the shared wording
 * rules. Wording neither knows stays without a stage, so it remains visible
 * for review.
 */
export function marutiAirStage(wording: string): ClassifiedWording | null {
  const mapped = marutiAirMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : marutiAirMappedStage(wording)),
  gaps: [],
};
