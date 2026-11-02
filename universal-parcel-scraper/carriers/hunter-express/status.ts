import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Hunter Express's scan and status wordings, which come without codes. Only
 * wordings seen on the tracker are mapped; another falls to the shared
 * wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording('Pickup Completed'), 'accepted'],
  [normalizeStatusWording('Depot In'), 'in_transit'],
  // Kept at the depot for the next run, as a parcel that arrives after the day's run is.
  [normalizeStatusWording('Held For Processing'), 'in_transit'],
  [normalizeStatusWording('On Delivery'), 'out_for_delivery'],
  // The status above the history once the van has left the depot.
  [normalizeStatusWording('OnDelivery, Left Depot'), 'out_for_delivery'],
  [normalizeStatusWording('Delivered'), 'delivered'],
]);

/** The stage Hunter Express's map gives a wording in `normalizeStatusWording` form. */
export function hunterExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function hunterExpressStage(wording: string): ClassifiedWording | null {
  const mapped = hunterExpressMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => hunterExpressMappedStage(wording),
  gaps: [],
};
