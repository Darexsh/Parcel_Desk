import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of an item's status on PBT's tracking page, in its heading and
 * in each row of its history. Rows carry no code. The map covers the wording
 * seen on the tracker and on the tracking service it replaced; other wording
 * falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // Listed with the pickup request's reference, before the pickup.
  ['pickup requested', 'registered'],
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['in depot', 'in_transit'],
  // The item waits in a delivery driver's bay at the delivering depot, sometimes for days.
  ['in drivers bay', 'in_transit'],
  ['goods picked up', 'accepted'],
  ['goods with delivery courier', 'out_for_delivery'],
  ['signed as received', 'delivered'],
]);

/** The stage the map gives PBT's wording, if it knows it. */
export function pbtMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A status's stage: the map, else the shared wording rules, else nothing. */
export function pbtStage(wording: string): ClassifiedWording | null {
  const mapped = pbtMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : pbtMappedStage(wording)),
  gaps: [],
};
