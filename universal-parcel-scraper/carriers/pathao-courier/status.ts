import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The step of the journey Pathao files each scan under, the first entry of its
 * `grouped_status`, which the tracking page heads the scans with. Spellings
 * differ in punctuation ("In-Transit", the rail's "In Transit"), so a code is
 * compared in capitals with spaces for hyphens and underscores.
 */
const GROUPS: ReadonlyMap<string, Stage> = new Map([
  // Booked: pickup requested, order confirmed, a rider assigned to collect it, a weight correction.
  ['ACCEPTED', 'registered'],
  ['PICKED', 'accepted'], // Received at the pickup hub or being sorted there.
  ['IN TRANSIT', 'in_transit'], // On the way to, at or leaving the central sorting hub.
  ['READY FOR DELIVERY', 'in_transit'], // At the delivery hub; see OUT_FOR_DELIVERY.
  ['DELIVERED', 'delivered'],
  // Held at the delivery hub, as when the recipient cannot be reached; the
  // staff note says why. Another attempt or a return follows.
  ['ON HOLD', 'exception'],
  ['RETURN', 'returned'], // On its way back to the merchant.
]);

/** A delivery-hub scan that hands the parcel to a rider for delivery. */
const OUT_FOR_DELIVERY = /\b(?:assigned|picked[\s-]?up)\b.*\bfor delivery\b|\bout for delivery\b/i;

function groupKey(code: string): string {
  return code.toUpperCase().replace(/[\s_-]+/g, ' ').trim();
}

/** The stage Pathao's step and the scan's wording give a scan. */
export function pathaoMappedStage(code: string, wording: string): Stage | undefined {
  const key = groupKey(code);
  if (key === 'READY FOR DELIVERY' && OUT_FOR_DELIVERY.test(wording)) return 'out_for_delivery';
  return GROUPS.get(key);
}

/** A scan's stage: its step, else the shared wording rules, else nothing. */
export function pathaoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? pathaoMappedStage(code, wording) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? pathaoMappedStage(code, wording) : undefined),
  gaps: [],
};
