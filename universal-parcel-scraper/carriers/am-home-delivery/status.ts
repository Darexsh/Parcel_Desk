import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording AM Home Delivery's tracking page shows: a history row's status,
 * the shipment's current and last mile statuses and the steps of its progress
 * rail. None carries a code. The older Carrier Logistics tracker's wording is
 * kept too. Other wording falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['pickup notification received', 'registered'],
  ['electronic order received', 'registered'],
  ['order received pending pickup', 'registered'],
  ['electronic billing information received', 'registered'],
  ['shipment data received-pending pick up', 'registered'],
  ['picked up', 'accepted'],
  ['order picked up', 'accepted'],
  // The first terminal after the pickup, where the freight is gathered for the linehaul.
  ['received in consolidation center', 'accepted'],
  ['received in ny terminal', 'accepted'],
  ['in transit', 'in_transit'],
  ['in-transit to delivery terminal', 'in_transit'],
  ['intransit to delivery terminal', 'in_transit'],
  ['in transit to ca', 'in_transit'],
  ['received in delivery terminal', 'in_transit'],
  // The delivery appointment is set while the freight waits at the delivery terminal.
  ['scheduled', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivery attempted', 'failed_attempt'],
  ['completed', 'delivered'],
]);
// The older tracker's delivery row names the delivering town after the wording.
const DELIVERED_THANKS = /^delivered; thank you for using am home delivery\b/;

/** The stage the map gives AM Home Delivery's wording, if it knows it. */
export function amHomeDeliveryMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.get(normalized) ?? (DELIVERED_THANKS.test(normalized) ? 'delivered' : undefined);
}

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function amHomeDeliveryStage(wording: string): ClassifiedWording | null {
  const mapped = amHomeDeliveryMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording. It leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : amHomeDeliveryMappedStage(wording)),
  gaps: [],
};
