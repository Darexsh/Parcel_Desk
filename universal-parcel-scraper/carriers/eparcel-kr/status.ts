import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes the tracker prints in brackets before a scan's wording. Only codes
 * seen on the tracker are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['10', 'registered'], // The sender booked the parcel; it is not in the warehouse yet.
  ['20', 'accepted'], // Received at eParcel's warehouse in Korea.
  ['30', 'in_transit'], // Left the warehouse for the airport.
  ['100', 'in_transit'], // The flight left Korea.
  ['200', 'in_transit'], // The flight landed in the destination country.
  ['500', 'in_transit'], // The delivery company there took the parcel in.
  // The delivery company's own line under this code has said the parcel is at
  // its warehouse and that it is on the way to the door, so the code says no
  // more than in transit.
  ['550', 'in_transit'],
  ['700', 'delivered'],
]);

/** The stage eParcel Korea's codes give a scan code. */
export function eparcelKrMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function eparcelKrStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = eparcelKrMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? eparcelKrMappedStage(code) : undefined),
  gaps: [],
};
