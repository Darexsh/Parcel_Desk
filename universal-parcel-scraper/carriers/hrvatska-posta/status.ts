import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English wording of Hrvatska pošta's tracker, which the adapter asks
 * for. The scans carry no code. An item waiting at a post office or in a
 * parcel locker is ready for pickup, and one handed back to its sender, or
 * on its way back, is returned.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The sender entered the item's data; Hrvatska pošta does not have it yet.
  ['item announced', 'registered'],
  ['item received', 'accepted'],
  // An outbound item at the exchange office, sent abroad, and received by the post abroad.
  ['item received at exchange office', 'in_transit'],
  ['item sent', 'in_transit'],
  ['item sent abroad', 'in_transit'],
  ['item received in destination country', 'in_transit'],
  // The post abroad, relayed: its office of exchange sending the item on, and the delivering office
  // holding it before the delivery round.
  ['item sent from exchange office', 'in_transit'],
  ['item held at post office', 'in_transit'],
  // The destination's customs, relayed: the item presented to customs and handed back after it.
  ['item sent to customs', 'customs'],
  ['item returned from customs', 'in_transit'],
  ['delivery was redirected to the parcelstation', 'in_transit'],
  ['item is out for delivery', 'out_for_delivery'],
  ['delivery attempt', 'failed_attempt'],
  // Left uncollected at the office, before it goes back to its sender.
  ['item not delivered', 'failed_attempt'],
  ['item can be picked up at the post office', 'ready_for_pickup'],
  ['the shipment has been handed over to the parcelstation', 'ready_for_pickup'],
  ['item delivered', 'delivered'],
  ['item delivered to sender', 'returned'],
  ['item returned to sender', 'returned'],
]);

/** The stage the map gives Hrvatska pošta's wording, if it knows it. */
export function hrvatskaPostaScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A label an aggregator relays from the tracker, staged by the map. Its
 * receipt is also a facility abroad receiving an item that already moved on,
 * and the item handed back to its sender starts the trip back.
 */
export function hrvatskaPostaScan(label: string): { stage: Stage; wording: string; receipt?: true; returnLeg?: true } | undefined {
  const stage = hrvatskaPostaScanStage(label);
  if (!stage) return undefined;
  const key = normalizeStatusWording(label);
  return { stage, wording: label.trim(), ...(key === 'item received' ? { receipt: true as const } : {}),
    ...(key === 'item returned to sender' ? { returnLeg: true as const } : {}) };
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function hrvatskaPostaStage(wording: string): ClassifiedWording | null {
  const mapped = hrvatskaPostaScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : hrvatskaPostaScanStage(wording)),
  gaps: [],
};
