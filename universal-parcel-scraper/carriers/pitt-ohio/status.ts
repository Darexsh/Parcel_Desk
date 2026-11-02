import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Pitt Ohio's shipment status page, without the place a row
 * ends with: the status over the page and each row of the shipment history.
 * Neither carries a code. A row without a place can end with a full stop,
 * which the map ignores.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The driver reached the shipper; the freight is not collected yet.
  ['arrived at shipper pickup location', 'registered'],
  // The driver left the shipper with the freight.
  ['pickup - departure', 'accepted'],
  ['shipment arrived at pitt ohio origin terminal', 'in_transit'],
  ['shipment in transit to destination terminal', 'in_transit'],
  ['shipment in transit to destination terminal from terminal', 'in_transit'],
  ['arrived at pitt ohio intermediate terminal', 'in_transit'],
  ['departed from intermediate terminal', 'in_transit'],
  ['shipment arrived at pitt ohio destination terminal', 'in_transit'],
  // The delivering terminal put the freight on a delivery run's schedule; it has not left.
  ['scheduled for delivery to consignee', 'in_transit'],
  ['shipment out for delivery to consignee', 'out_for_delivery'],
  ['delivery attempted - incorrect address', 'failed_attempt'],
  ['delivered at consignee location', 'delivered'],
  // The status over the page.
  ['delivered', 'delivered'],
]);

/** The stage the map gives Pitt Ohio's wording, if it knows it. */
export function pittOhioMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording).replace(/\s*\.$/, ''));
}

/**
 * A row's or the page status's stage from the map, else from the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function pittOhioStage(wording: string): ClassifiedWording | null {
  const mapped = pittOhioMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : pittOhioMappedStage(wording)),
  gaps: [],
};
