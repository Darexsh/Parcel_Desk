import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Cyprus Post's tracker names each scan with the event name of the UPU's IPS
 * system, in English, mostly with the leg it belongs to: "(Otb)" for the
 * posting country, "(Inb)" for the destination and "(Domestic)". Foreign
 * posts' events relayed by their electronic data use the same names. The
 * scans carry no code. The map reads the name without its leg; the shared
 * rules read most of these names as no milestone at all.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['receive item from customer', 'accepted'],
  ['receive item from sender', 'accepted'],
  ['receive item at location', 'in_transit'],
  ['send item to domestic location', 'in_transit'],
  ['receive item at office of exchange', 'in_transit'],
  ['receive item at office of exchange in country of origin', 'in_transit'],
  ['insert item into bag', 'in_transit'],
  ['item sent to country of destination', 'in_transit'],
  ['arrival of item at country of destination', 'in_transit'],
  ['send item to processing point', 'in_transit'],
  ['send item to next processing point', 'in_transit'],
  ['receive item at processing point', 'in_transit'],
  ['send items to delivery point', 'in_transit'],
  ['send items to delivery point/ collection point', 'in_transit'],
  ['receive item at delivery office', 'in_transit'],
  // Waiting at the delivery office for the next round, not for collection.
  ['hold item at point of delivery', 'in_transit'],
  ['send item to customs', 'customs'],
  // Customs handed the item back: a release, which the shared rules read as customs.
  ['return item from customs', 'in_transit'],
  // The postman took the item.
  ['handover item to delivery agent', 'out_for_delivery'],
  ['unsuccessful item delivery attempt', 'failed_attempt'],
  ['item not delivered/ pending delivery', 'failed_attempt'],
  ['item not delivered (please see next column)', 'failed_attempt'],
  ['receive item at collection point for pick-up', 'ready_for_pickup'],
  ['deliver item', 'delivered'],
  ['item delivered to addressee', 'delivered'],
]);

// The leg a name ends with.
const LEG = /\s*\((?:otb|inb|domestic)\)$/;

/** The stage the map gives Cyprus Post's wording, if it knows it. */
export function cyprusPostScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording).replace(LEG, ''));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function cyprusPostStage(wording: string): ClassifiedWording | null {
  const mapped = cyprusPostScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : cyprusPostScanStage(wording)),
  gaps: [],
};
