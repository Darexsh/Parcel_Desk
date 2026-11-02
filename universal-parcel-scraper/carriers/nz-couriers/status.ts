import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Freightways' scan types, with the subtype after a slash where it decides
 * the stage. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['P', 'accepted'], // Picked Up.
  ['ONBD', 'out_for_delivery'], // On board the delivery vehicle.
  ['D', 'delivered'],
  ['3P/D', 'delivered'], // Delivered by the rural delivery partner the parcel was handed to.
  ['STAT/REDEL', 'in_transit'], // Sent out again after a delivery that did not happen.
  ['STAT/RZDEL', 'in_transit'], // A notice that the address is rural, with two or three more days to delivery.
]);

// A delivery scan that hands the parcel to a rural delivery partner, who
// delivers it days later; the help centre's "Delivered by courier or branch".
const HANDOVER = /\bhanded over\b|\bby courier or branch\b/i;
// The parcel held at the branch's freight office after a delivery that did not happen.
const HELD = 'STAT/HLDFR8';

/** The stage New Zealand Couriers' codes give a scan. */
export function nzCouriersMappedStage(code: string, wording = ''): Stage | undefined {
  const key = code.toUpperCase();
  // Every subtype of a non-delivery gives its reason, such as a card left.
  if (key === 'NOND' || key.startsWith('NOND/')) return 'failed_attempt';
  const stage = CODES.get(key);
  return stage === 'delivered' && key === 'D' && HANDOVER.test(wording) ? 'in_transit' : stage;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function nzCouriersStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = nzCouriersMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code.toUpperCase() === HELD) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? nzCouriersMappedStage(code, wording) : undefined),
  gaps: [
    { code: HELD, note: 'Held at the branch\'s freight office after a delivery that did not happen; it does not say whether the parcel waits for collection or another delivery.' },
  ],
};
