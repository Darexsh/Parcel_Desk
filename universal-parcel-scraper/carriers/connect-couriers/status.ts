import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings Connect Couriers' tracker gives its scans, which carry no
 * code. Only wordings seen in replies are mapped; another falls to the
 * shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment data received', 'registered'], // The sender's data came before the parcel.
  ['arrived at operations facility - malta', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['attempted delivery / client not home', 'failed_attempt'],
  // Kept at the depot for the recipient to collect, at their request.
  ['awaiting collection by recipient as requested', 'ready_for_pickup'],
  ['delivered', 'delivered'],
]);

/** The stage Connect Couriers' map gives a scan's wording in `normalizeStatusWording` form. */
export function connectCouriersMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function connectCouriersStage(wording: string): ClassifiedWording | null {
  const mapped = connectCouriersMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => connectCouriersMappedStage(wording),
  gaps: [],
};
