import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Trackon's scan codes, which come with each scan. Only codes seen in replies
 * are mapped; another code falls to Trackon's own wordings, then to the shared
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['FMDT', 'accepted'], // S/MENT PICKED UP: collected from the sender.
  ['BOKN', 'accepted'], // S/MENT BOOKED at the branch that takes it.
  ['DRBG', 'out_for_delivery'], // DELIVERY MANIFEST PREPARED FOR {area}: on a delivery run sheet.
  ['DDUF', 'delivered'], // DELIVERED WITH MOBILE APP UPDATE.
  ['ROFF', 'exception'], // RTO HANDOVER PREPARED FOR {branch}: on its way back to the sender.
  ['RHOD', 'returned'], // RTO DELIVERED TO CUSTOMER / BRANCH: back with the sender.
]);
// A return to origin. The shared rules would read its delivery back to the sender as a delivery.
const RETURN = /^\s*RTO\b/i;
const DELIVERED = /\bDELIVERED\b/i;
// Trackon's wordings the shared rules do not know.
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^\s*(?:S\/MENT|SHIPMENT) BOOKED\b/i, 'accepted'],
  [/^\s*DELIVERY MANIFEST PREPARED\b/i, 'out_for_delivery'],
];

/** The stage Trackon's scan codes give a code, or Trackon's own wordings give a scan. */
export function trackonMappedStage(code: string | null, wording: string): Stage | undefined {
  const mapped = code ? CODES.get(code.toUpperCase()) : undefined;
  if (mapped) return mapped;
  // A return on its way is an exception; one delivered back has been returned.
  if (RETURN.test(wording)) return DELIVERED.test(wording) ? 'returned' : 'exception';
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A scan's stage: its code or Trackon's own wording, else the shared wording rules, else nothing. */
export function trackonStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = trackonMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => trackonMappedStage(code, wording),
  gaps: [],
};
