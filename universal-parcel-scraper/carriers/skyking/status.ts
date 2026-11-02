import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// A return to origin. The shared rules would read its delivery back to the sender as a delivery.
const RETURN = /^\s*RTO\b/i;
const DELIVERED = /\bDELIVERED\b/i;
/**
 * SkyKing's scans come without a code, so their wordings stage them. A failed
 * delivery comes before a delivery: the shared rules read "Un-Delivered" as one.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^\s*UN-?\s?DELIVERED\b/i, 'failed_attempt'],
  [/^\s*DELIVERED\b/i, 'delivered'],
  [/^\s*OUT FOR DELIVERY\b/i, 'out_for_delivery'],
  [/^\s*INBOUND SCAN DONE\b/i, 'in_transit'],
  [/^\s*FORWARDED TO\b/i, 'in_transit'],
];

/** The stage SkyKing's own wordings give a scan. */
export function skykingMappedStage(wording: string): Stage | undefined {
  // A return on its way is an exception; one delivered back has been returned.
  if (RETURN.test(wording)) return DELIVERED.test(wording) ? 'returned' : 'exception';
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A scan's stage: SkyKing's own wording, else the shared wording rules, else nothing. */
export function skykingStage(wording: string): ClassifiedWording | null {
  const mapped = skykingMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => skykingMappedStage(wording),
  gaps: [],
};
