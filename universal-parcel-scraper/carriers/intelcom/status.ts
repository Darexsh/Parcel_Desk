import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Codes observed in the public Canadian tracking service. The short labels
// are often marketing phrases rather than literal milestone names.
const STAGES: Readonly<Record<string, Stage>> = {
  '0': 'registered', '105': 'accepted', '106': 'in_transit', '108': 'in_transit', '155': 'in_transit',
  '300': 'out_for_delivery', '601': 'delivered', '860': 'exception',
  // A return collected from the customer: the driver is coming, has it, and has
  // sent it on towards the merchant, where Intelcom's part ends.
  '200': 'registered', '602': 'accepted', '850': 'in_transit',
};

/** The stage of a status code the tracking service is known to send. */
export function intelcomCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(STAGES, code) ? STAGES[code] : undefined;
}

/**
 * What the map says about one scan: its code. Another code is staged by the parcel's delivered
 * flag or the shared wording rules, and the stored scan does not keep the flag, so it stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? intelcomCodeStage(code) : undefined), gaps: [] };
