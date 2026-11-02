import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Mongol Infinity Post's scan codes. The delivery system borrows some of
 * UPU's EMS event letters (`EMB`, `EMG`, `EMH`, `EMI`) and adds its own
 * (`EM3`, `EM`); its first scheme's lowercase codes are still named in the
 * graph of next statuses each scan carries. The customs route has codes of
 * its own. Another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['EMB', 'in_transit'], // Received at sorting, to go on to the next branch.
  ['EMG', 'in_transit'], // Received at the delivery branch.
  ['EM3', 'out_for_delivery'],
  ['EMH', 'failed_attempt'], // A delivery attempt that did not deliver; its reason is required.
  ['EMI', 'delivered'],
  ['EM', 'returned'], // Sent back.
  ['DELIVERY_COMPLETED', 'delivered'],
  ['DELIVERY_TRY', 'failed_attempt'],
  ['CANCELLED', 'exception'], // The shipment was cancelled.
  ['CUSTOMS_PICK_UP_BY_PROVIDER', 'in_transit'], // Collected by the clearing provider before clearance starts.
  ['CUSTOMS_CLEARANCE_STARTED', 'customs'],
  ['CUSTOMS_CLEARANCE_CHECKED', 'customs'],
  ['CUSTOMS_RELEASED', 'in_transit'],
  ['CUSTOMS_TRANSFERED_TO_COURIER', 'in_transit'],
]);

/** The stage Mongol Infinity Post's codes give a scan code. */
export function mongolInfinityPostMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function mongolInfinityPostStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = mongolInfinityPostMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? mongolInfinityPostMappedStage(code) : undefined),
  gaps: [],
};
