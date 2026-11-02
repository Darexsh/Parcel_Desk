import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Northline's status values, which its tracker's lookup gives each milestone
 * and the consignment. Only values seen in replies are mapped; another falls
 * to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // "Not Available": booked, before any step of the tracker's rail; 101 is the
  // first milestone, 200 the consignment's own status while it waits.
  ['101', 'registered'],
  ['200', 'registered'],
  ['201', 'accepted'], // Picked Up.
  ['401', 'in_transit'], // In Transit, after the pickup.
  ['501', 'in_transit'], // In Transit, before the destination depot.
  // Depot Arrival: the destination depot, also after a delivery run that came back.
  ['601', 'in_transit'],
  ['701', 'out_for_delivery'],
  ['851', 'delivered'],
]);

/** The stage Northline's status values give a value. */
export function northlineMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A milestone's stage: its value, else the shared wording rules, else nothing. */
export function northlineStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = northlineMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every value seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? northlineMappedStage(code) : undefined),
  gaps: [],
};
