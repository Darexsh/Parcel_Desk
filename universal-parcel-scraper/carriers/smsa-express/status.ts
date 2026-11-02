import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A wording in lower case, with single spaces and no closing full stop, as the map keys it. */
export function smsaKey(wording: string): string {
  return wording.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
}

/**
 * The scans SMSA writes in English, on its page without a code and in its
 * app's service with one; the wording is the same in both. The delivery scan
 * loses its signer before it gets here. A parcel waiting for its clearance,
 * held for duties or held for its customs papers before delivery is customs;
 * released by customs it moves on. `Picked Up` and the hub scans are the
 * former tracker's wording.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['shipment picked up from the shipper', 'accepted'],
  ['picked up', 'accepted'],
  ['shipment departed smsa origin facility', 'in_transit'],
  ['shipment received at smsa sorting facility', 'in_transit'],
  ['shipment departed smsa sorting facility', 'in_transit'],
  ['arrived hub facility', 'in_transit'],
  ['departed hub facility', 'in_transit'],
  ['shipment departed origin country', 'in_transit'],
  ['shipment departed at the border - in transit to destination', 'in_transit'],
  ['shipment arrived at destination country - under clearance process', 'customs'],
  ['shipment on hold at customs - waiting to complete payment to customs', 'customs'],
  ['customs released', 'in_transit'],
  ['delivery on hold - waiting customs info/invoice completion', 'customs'],
  ['arrived delivery facility', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['attempted delivery - consignee no response', 'failed_attempt'],
  ['delivered', 'delivered'],
]);

/** The stage the map gives a scan's wording, if it knows it. */
export function smsaScanStage(wording: string): Stage | undefined {
  return SCANS.get(smsaKey(wording));
}

/** A scan's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function smsaStage(wording: string): ClassifiedWording | null {
  const mapped = smsaScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The map reads the wording, which the page shares with the app's service;
 * the app's codes come in variants, such as one per side of a border. It
 * leaves none of it out on purpose.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => smsaScanStage(wording),
  gaps: [],
};
