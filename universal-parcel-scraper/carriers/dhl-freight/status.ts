import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * ActiveTracing's status wording. The page shows no codes, so the map reads
 * the sentence. The adapter asks for English; the German sentences are the
 * page's own in German, as the catalog records them.
 */
const EXACT: ReadonlyMap<string, Stage> = new Map([
  // The order is in; the goods are still with the shipper.
  ['consignment created', 'registered'],
  ['collection arranged - ok', 'registered'],
  ['loaded by customer ready for collection', 'registered'],
  ['out for collection', 'registered'],
  ['collected', 'accepted'],
  ['received at terminal', 'in_transit'],
  ['shipped from terminal', 'in_transit'],
  ['arrival at destination', 'in_transit'],
  ['loaded into ferry', 'in_transit'],
  ['customs cleared', 'in_transit'],
  ['on hold - in customs clearance', 'customs'],
  // The delivery terminal holds the goods until a delivery day is agreed.
  ['shipment in warehouse - awaiting delivery appointment', 'in_transit'],
  ['shipment in warehouse - delivery appointment booked', 'in_transit'],
  ['shipment in warehouse - ready for self collection by consignee', 'ready_for_pickup'],
  // Nothing moves until the consignee pays.
  ['shipment in warehouse - waiting for consignee payment', 'exception'],
  // Sent straight from the shipper's terminal to the consignee, which can take days abroad.
  ['direct delivery', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['received by consignee', 'delivered'],
  ['delivered', 'delivered'],
  ['shipment delivered - new delivery address following consignee instruction', 'delivered'],
  ['shipment delivered with exception', 'delivered'],
  // Part of the goods is still missing.
  ['shipment delivered with exception - partly delivered', 'exception'],
  ['exception occurred - strike', 'exception'],
  ['new shipping instruction - consignment cancelled by sender', 'exception'],
  ['new shipping instruction - shipment returned', 'returned'],
  ['auftrag erfasst', 'registered'],
  ['in abholung', 'registered'],
  ['abholung', 'accepted'],
  ['empfangen im terminal', 'in_transit'],
  ['verladen', 'in_transit'],
  ['avisierung', 'in_transit'],
  ['avisierung beim empfänger', 'in_transit'],
  ['in zustellung', 'out_for_delivery'],
  ['zugestellt', 'delivered'],
]);

/** Families whose reason follows a dash: the reason does not change the stage. */
const PREFIXES: ReadonlyArray<readonly [string, Stage]> = [
  // A collection that failed leaves the goods with the shipper.
  ['not collected - ', 'registered'],
  ['attempted dhl delivery - ', 'failed_attempt'],
  ['delayed during transport - ', 'in_transit'],
];

/** The sentence in one form: lower case, plain hyphens, single spaces, no closing full stop. */
function key(wording: string): string {
  return wording.toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/** The stage ActiveTracing's own sentence gives a scan, if the map knows it. */
export function dhlFreightMappedStage(wording: string): Stage | undefined {
  const text = key(wording);
  return EXACT.get(text) ?? PREFIXES.find(([start]) => text.startsWith(start))?.[1];
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function dhlFreightStage(wording: string): ClassifiedWording | null {
  const mapped = dhlFreightMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => dhlFreightMappedStage(wording),
  gaps: [],
};
