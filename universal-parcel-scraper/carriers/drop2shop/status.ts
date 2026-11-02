import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Drop2Shop's event codes. COLL-8's own records are `DAT` and the customs
 * family `CUSM`; the `D2M` codes relay the delivery partner's scans. Only codes
 * seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DAT', 'registered'], // COLL-8 created the parcel record.
  ['D2MS001', 'registered'], // The partner has the sender's data, not yet the parcel.
  ['CUSM015', 'customs'], // COLL-8 is taking the parcel through Irish customs on its way in.
  ['D2MS002', 'in_transit'],
  ['D2MS004', 'out_for_delivery'],
  // "Your parcel has been delivered", once worded as the collection from the pickup point.
  ['D2MD001', 'delivered'],
]);

/** The stage Drop2Shop's codes give a scan code. */
export function drop2shopMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function drop2shopStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = drop2shopMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? drop2shopMappedStage(code) : undefined),
  gaps: [],
};
