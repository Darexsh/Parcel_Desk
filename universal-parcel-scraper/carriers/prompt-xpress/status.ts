import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses Prompt Xpress's visibility portal names a parcel's newest
 * movement by, which carry no code. Other wording goes to the shared wording
 * rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The tracking page names the same parcel Delivered.
  ['consignment completed', 'delivered'],
]);

/** The stage the map gives Prompt Xpress's wording, if it knows it. */
export function promptXpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/**
 * A status's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function promptXpressStage(wording: string): ClassifiedWording | null {
  const mapped = promptXpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The portal carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : promptXpressMappedStage(wording)),
  gaps: [],
};
