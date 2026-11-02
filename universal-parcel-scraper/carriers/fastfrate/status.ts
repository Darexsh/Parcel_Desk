import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Fastfrate's tracker timeline. Rows carry no code. The driver's
 * device adds its arrival at and departure from the shipper and the consignee.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['shipment created', 'registered'],
  // The shipper's electronic order, before anyone collects the freight.
  ['shipment accepted from edi', 'registered'],
  ['driver assigned for pickup', 'registered'],
  // The pickup driver at the shipper, before the freight is on board.
  ['arrived at shipper', 'registered'],
  ['picked up', 'accepted'],
  // The pickup driver leaving the shipper with the freight.
  ['departed shipper', 'accepted'],
  ['on dock at origin terminal', 'in_transit'],
  ['enroute to destination terminal', 'in_transit'],
  ['on dock at destination terminal', 'in_transit'],
  ['appointment requested', 'in_transit'],
  // A delivery appointment, dated with the appointment's own time.
  ['scheduled appointment', 'in_transit'],
  ['loaded to delivery unit', 'out_for_delivery'],
  // The delivery driver at the consignee and leaving it, around the delivery.
  ['arrived at consignee', 'out_for_delivery'],
  ['departed consignee', 'out_for_delivery'],
  ['delivered', 'delivered'],
  // The former FastNet page's delivery status.
  ['delivered by appointment', 'delivered'],
]);

/** The stage the map gives Fastfrate's wording, if it knows it. */
export function fastfrateMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function fastfrateStage(wording: string): ClassifiedWording | null {
  const mapped = fastfrateMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The timeline carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : fastfrateMappedStage(wording)),
  gaps: [],
};
