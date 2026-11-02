import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event names of the UPU's IPS system, which the tracker prints in
 * English, mostly with their leg: "(Otb)" in the posting country, "(Inb)" in
 * the destination and "(EDI-received)" for a scan another post reported as
 * data. Foreign posts' scans use the same names, and so do other posts' IPS
 * pages. The map reads a name without its leg; the shared rules read most of
 * these names as no milestone.
 */
const IPS: ReadonlyMap<string, Stage> = new Map([
  ['receive item from customer', 'accepted'],
  ['receive item at office of exchange', 'in_transit'],
  ['insert item into bag', 'in_transit'],
  ['send item abroad', 'in_transit'],
  ['send item to customs', 'customs'],
  // Customs recorded its status for the item; the scan's detail names it.
  ['record item customs information', 'customs'],
  // Customs handed the item back: a release, which the shared rules read as customs.
  ['return item from customs', 'in_transit'],
  ['send item to domestic location', 'in_transit'],
  ['receive item at location', 'in_transit'],
  ['receive item at sorting centre', 'in_transit'],
  ['insert item into domestic bag', 'in_transit'],
  ['receive item at delivery office', 'in_transit'],
  ['send item out for physical delivery', 'out_for_delivery'],
  ['handover item to delivery agent', 'out_for_delivery'],
  // The extra information gives the reason and what happens next, a return to the sender included.
  ['unsuccessful item delivery attempt', 'failed_attempt'],
  ['receive item at collection point for pick-up', 'ready_for_pickup'],
  ['deliver item', 'delivered'],
]);

// The leg a name ends with.
const LEG = /\s*\((?:otb|inb|edi-received)\)$/;

/** The stage the map gives a scan's event name, if it knows it. */
export function laPosteBurkinaFasoEventStage(name: string): Stage | undefined {
  return IPS.get(normalizeStatusWording(name).replace(LEG, ''));
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function laPosteBurkinaFasoStage(name: string): ClassifiedWording | null {
  const mapped = laPosteBurkinaFasoEventStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A scan's wording is its event name, then the
 * details of its extra information after a colon; the event name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : laPosteBurkinaFasoEventStage(wording.split(': ')[0]!)),
  gaps: [],
};
