import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The transaction types of Madhur's tracker, which head each row's free
 * status wording, such as `PARCEL RECEIVED` before "RECEIVED IN … FROM …". A
 * delivery sheet update depends on its wording; other types fall to the shared
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['BOOKING', 'accepted'], // Booked at the branch that took the consignment.
  ['DOCUMENT OUT', 'in_transit'], // A document made ready to leave for the next branch.
  ['PARCEL DISPATCH', 'in_transit'], // Forwarded to the next branch.
  ['BAG FORWARD', 'in_transit'], // The bag holding it forwarded to the next branch.
  ['PARCEL RECEIVED', 'in_transit'], // Received at a branch on the way, the destination's included.
  ['MANIFEST OUTWARD', 'in_transit'], // The older tracker's forwarding step.
  ['OUT FOR DELIVERY', 'out_for_delivery'], // Sent out with the delivery staff.
]);

/** The delivery sheet's update, whose wording says what came of the delivery. */
export const DELIVERY_SHEET = 'RUNSHEET UPDATE';
const DELIVERED = /^delivered\b/;

/** A transaction type as the map keys it: capitals and single spaces. */
export function madhurCode(code: string): string {
  return code.toUpperCase().trim().split(/\s+/).join(' ');
}

/** The stage the map gives a row's transaction type and wording. */
export function madhurMappedStage(code: string, wording: string): Stage | undefined {
  const key = madhurCode(code);
  if (key === DELIVERY_SHEET) return DELIVERED.test(normalizeStatusWording(wording)) ? 'delivered' : undefined;
  return CODES.get(key);
}

/** A row's stage: its transaction type in the map, else the shared wording rules, else nothing. */
export function madhurStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = madhurMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? madhurMappedStage(code, wording) : undefined),
  gaps: [],
};
