import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PostEx's status codes, `transactionStatusMessageCode`. Only codes seen in
 * replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0001', 'registered'], // At the merchant's warehouse: booked, not yet handed over.
  ['0031', 'accepted'], // Picked up from the merchant, on its way to PostEx's warehouse.
  ['0003', 'in_transit'], // Received at a PostEx warehouse.
  ['0033', 'in_transit'], // Sent on to the destination city.
  ['0035', 'in_transit'], // Arrived at a transit hub.
  ['0038', 'in_transit'], // At the delivering hub, waiting for a rider.
  ['0004', 'out_for_delivery'],
  ['0013', 'failed_attempt'], // With the reason, as "Attempt Made: CNA(CUSTOMER NOT AVAILABLE)".
  ['0005', 'delivered'],
]);

/** The stage PostEx's codes give a status code. */
export function postexMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function postexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = postexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? postexMappedStage(code) : undefined),
  gaps: [],
};
