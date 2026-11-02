import { languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

function comparable(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Old Dominion's shipment statuses. The trace page's progress rail files the
 * appointment, delay and "Returned To Dock" statuses under In Transit and shows
 * "Agent Handoff" as Out for Delivery; "Received At Dock" takes the pickup's
 * place when the shipper brought the freight in. The rail lights nothing for
 * "Pickup Confirmed", as for "Pickup Requested": the freight is not picked up
 * yet. Nor does it for "Arrived at Consignee", which comes at the consignee's
 * site between Out for Delivery and Delivered. An appointment status is about
 * booking the delivery, not a delivery attempt.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['PICKUP REQUESTED', 'registered'],
  ['PICKUP CONFIRMED', 'registered'],
  ['PICKUP COMPLETED', 'accepted'],
  ['RECEIVED AT DOCK', 'accepted'],
  ['IN TRANSIT', 'in_transit'],
  ['APPOINTMENT SET/CONFIRMED', 'in_transit'],
  ['APPOINTMENT ATTEMPTED', 'in_transit'],
  ['APPOINTMENT CANCELLED', 'in_transit'],
  ['DELAYED', 'in_transit'],
  ['WEATHER DELAY', 'in_transit'],
  ['RETURNED TO DOCK', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['AGENT HANDOFF', 'out_for_delivery'],
  ['ARRIVED AT CONSIGNEE', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['DELIVERY CONFIRMED', 'delivered'],
]);

/** A status's stage from Old Dominion's own list; any other status is left to the shared wording rules. */
export function oldDominionStatus(status: string): ClassifiedStatus | undefined {
  const stage = STAGES.get(comparable(status));
  return stage ? { status: languageStageStatus(stage), stage } : undefined;
}

/** What the map says about one scan, by its status, which is the provider code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? oldDominionStatus(code)?.stage : undefined),
  gaps: [],
};
