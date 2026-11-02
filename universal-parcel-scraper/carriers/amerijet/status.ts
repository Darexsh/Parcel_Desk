import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestone words Amerijet's tracker puts on each scan of an air waybill.
 * Only those seen in replies are mapped; another word falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['BOOKED', 'registered'], // Space booked on a flight; Amerijet does not have the cargo yet.
  ['ACCEPTED', 'accepted'], // Received at the origin station.
  ['DEPARTED', 'in_transit'], // Left a station by air or by truck.
  ['ARRIVED', 'in_transit'], // Reached a station, the destination included.
  ['DELIVERED', 'delivered'], // Handed to the consignee or its agent at the destination station.
]);

/** The stage Amerijet's milestone word gives a scan. */
export function amerijetMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

/** A scan's stage: its milestone word, else the shared wording rules, else nothing. */
export function amerijetStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = amerijetMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? amerijetMappedStage(code) : undefined),
  gaps: [],
};
