import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * C3X's scan codes. Only codes seen in replies are mapped; another code falls
 * to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The shipment's details reached C3X. They can come after the parcel did.
  ['INF', 'registered'],
  ['AF', 'in_transit'], // Arrived at a C3X facility.
  ['WC', 'out_for_delivery'], // With the delivery courier, before the delivery that day.
  ['POD', 'delivered'],
]);

/** The stage C3X's codes give a scan code. */
export function c3xMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function c3xStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = c3xMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen moves the parcel; none is left out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? c3xMappedStage(code) : undefined),
  gaps: [],
};
