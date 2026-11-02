import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TIKI's scan codes: a family of letters, then a number within it for most
 * families, as `MDE 01`. Only codes seen in replies are mapped; another code
 * falls to the wording rules, which read the `Failed :` of a delivery
 * exception the map has not seen.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // Entered at the counter or agent that took the shipment; the number of the
  // code differs with the channel it came in by.
  ['MDE 01', 'accepted'],
  ['MDE 02', 'accepted'],
  ['MDE 04', 'accepted'],
  // The order cancelled before TIKI carried it.
  ['MDE 07', 'exception'],
  // Arrived at the origin city's TIKI office after collection.
  ['MDE 12', 'in_transit'],
  // Left for the next city, alone or under a manifest.
  ['CON 01', 'in_transit'],
  ['ROS', 'in_transit'],
  ['TRS', 'in_transit'],
  ['INC 01', 'in_transit'],
  ['DEL 01', 'out_for_delivery'],
  // Delivery exceptions: out of working hours, an incomplete address, an
  // address not found, and the parcel held at the office on request.
  ['DEX 02', 'failed_attempt'],
  ['DEX 03', 'failed_attempt'],
  ['DEX 04', 'failed_attempt'],
  ['DEX 09', 'failed_attempt'],
  ['POD 01', 'delivered'],
  // Handed back to the sender; its wording starts with Success too.
  ['POD 04', 'returned'],
]);

/** The stage a TIKI code gives a scan, with its spacing as the reply writes it. */
export function tikiCodeStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function tikiStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = tikiCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * Every scan carries a code, and the map reads the code alone. The wordings
 * recorded from TIKI's former mobile tracker and from guides came without
 * one; the adapter does not see them.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? tikiCodeStage(code) : undefined),
  gaps: [],
};
