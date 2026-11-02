import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// A return to origin, as Indian couriers word it. The shared rules would read its delivery back to the sender as a delivery.
const RETURN = /^\s*RTO\b/i;
const DELIVERED = /\bDELIVERED\b/i;
/**
 * ST Courier's scans and summary come without a code, so their wordings stage
 * them. A hub scan is in transit: the shared rules read "Received at Hub" as an
 * acceptance. "Forwarded to" names the next branch's code.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^\s*RECEIVED AT HUB\b/i, 'in_transit'],
  [/^\s*FORWARDED TO\b/i, 'in_transit'],
  [/^\s*IN[\s-]?TRANSIT\b/i, 'in_transit'],
  [/^\s*TAKEN FOR DELIVERY\b/i, 'out_for_delivery'],
  [/^\s*DELIVERED\b/i, 'delivered'],
];

/** The stage ST Courier's own wordings give a scan or the summary. */
export function stCourierMappedStage(wording: string): Stage | undefined {
  // A return on its way is an exception; one delivered back has been returned.
  if (RETURN.test(wording)) return DELIVERED.test(wording) ? 'returned' : 'exception';
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A wording's stage: ST Courier's own, else the shared wording rules, else nothing. */
export function stCourierStage(wording: string): ClassifiedWording | null {
  const mapped = stCourierMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stCourierMappedStage(wording),
  gaps: [],
};
