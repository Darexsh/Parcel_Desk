import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Dayton Freight's activity codes, read the way its tracking page reads them
 * for its progress rail. The page counts every other code as in transit.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DLV', 'delivered'], // "delivered to destination"
  ['SAD', 'delivered'], // The page shows it as a delivery too.
  ['PUD', 'out_for_delivery'],
  ['OFD', 'out_for_delivery'],
  ['SBR', 'accepted'], // Skeleton billed: the freight bill opened at the pickup, which the page shows as done.
  ['PUP', 'accepted'], // Picked up, on an expedited or truckload shipment.
  // An expedited or truckload shipment that is available, dispatched or whose truck
  // arrived at the shipper: the page shows no step reached.
  ['AVL', 'registered'],
  ['DSP', 'registered'],
  ['AS', 'registered'],
]);

/**
 * The wording, for a status relayed without its code. The former status page
 * ended some wordings with a terminal's code, and a partner's scan names the
 * partner's town.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^freight bill added$/, 'registered'],
  [/^loaded on outbound truck from [a-z]{3}$/, 'in_transit'],
  [/^unloaded at [a-z]{3}$/, 'in_transit'],
  [/^arrived at destination terminal\.?$/, 'in_transit'],
  [/^arrived at [a-z][a-z .'-]*, [a-z]{2}$/, 'in_transit'],
  [/^out for delivery from [a-z]{3}$/, 'out_for_delivery'],
  [/^delivered to destination$/, 'delivered'],
];

/** The stage the code gives, if the map knows it. */
export function daytonCodeStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

/** The stage the wording gives, if the map knows it. */
export function daytonWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** A status's stage: its code, else its wording, else the shared wording rules, else nothing. */
export function daytonStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = daytonCodeStage(code) ?? daytonWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status, by its code, else its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? daytonCodeStage(code) : undefined) ?? daytonWordingStage(wording),
  gaps: [],
};
