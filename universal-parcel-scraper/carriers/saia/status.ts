import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

function comparable(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The activities of Saia's history, each a scan's provider code. The pickup
 * driver collects the freight at the customer's site and departs from it: the
 * freight is picked up. "Pickup Complete" takes that place when a partner
 * carrier brought the freight in. It then moves between Saia terminals: the
 * origin, breakbulk (hub) and destination terminals, and leaves the
 * destination terminal on a delivery run.
 */
const ACTIVITIES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['PICKUP FROM CUSTOMER', 'accepted'],
  ['DEPART FROM CUSTOMER LOCATION', 'accepted'],
  ['PICKUP COMPLETE', 'accepted'],
  ['ARRIVED AT ORIGIN TERMINAL', 'in_transit'],
  ['DEPARTED FROM TERMINAL', 'in_transit'],
  ['ARRIVED AT BREAKBULK TERMINAL', 'in_transit'],
  ['ARRIVED AT DESTINATION TERMINAL', 'in_transit'],
  ['DISPATCHED FOR DELIVERY', 'out_for_delivery'],
]);

/** Activities at a Saia terminal, or leaving one, whose city is the terminal's. */
const TERMINAL: ReadonlySet<string> = new Set([
  'ARRIVED AT ORIGIN TERMINAL', 'DEPARTED FROM TERMINAL', 'ARRIVED AT BREAKBULK TERMINAL',
  'ARRIVED AT DESTINATION TERMINAL', 'DISPATCHED FOR DELIVERY',
]);

/**
 * The shipment's status, which the tracker shows as its badge and on its
 * progress rail. A delivery appointment and the destination terminal come
 * before the delivery run. "Delivered to Partner" hands the freight to a
 * partner carrier for the last leg, before the delivery. The tracker files
 * "Contact Customer Service 800-765-7242" and "Reconsigned" as errors without
 * a rail; a reconsignment changes where the freight goes, so the history
 * decides its stage.
 */
const SHIPMENT: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['PICKED UP', 'accepted'],
  ['IN TRANSIT', 'in_transit'],
  ['AT DESTINATION TERMINAL', 'in_transit'],
  ['APPOINTMENT SET', 'in_transit'],
  ['DELIVERED TO PARTNER', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['RETURNED TO SHIPPER', 'returned'],
  ['CONTACT CUSTOMER SERVICE 800-765-7242', 'exception'],
]);

/** The stage Saia's own list gives an activity. */
export function saiaActivityStage(activity: string): Stage | undefined {
  return ACTIVITIES.get(comparable(activity));
}

/** Whether an activity's city is a Saia terminal's rather than the customer's. */
export function saiaTerminalActivity(activity: string): boolean {
  return TERMINAL.has(comparable(activity));
}

/** The stage a shipment status gives, if the map knows one. */
export function saiaShipmentStage(status: string): Stage | undefined {
  return SHIPMENT.get(comparable(status));
}

/** An activity's stage from the map, else from the shared wording rules; null when neither knows it. */
export function saiaStage(activity: string): ClassifiedWording | null {
  const mapped = saiaActivityStage(activity);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(activity, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its activity, which is the provider code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? saiaActivityStage(code) : undefined),
  gaps: [],
};
