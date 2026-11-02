import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Scan codes (statusID) follow the UPU EMSEVT events, as the site's own
// status table pairs them: 3 EMA, 9 EMB, 15 EMC, 18 EMD, 23 EMF, 24 EDD,
// 25 EDE, 27 D012, 28 D013, 31 EDG, 32 EDH, 34 EMH, 35 EMI. Recorded codes
// are in statuses.json.
const CODES: Readonly<Record<string, Stage>> = {
  '3': 'accepted',
  '9': 'in_transit',
  '15': 'in_transit',
  '18': 'in_transit',
  '23': 'in_transit',
  '24': 'in_transit',
  '25': 'in_transit',
  '27': 'in_transit',
  // Delivery result K: on its way back to the origin post office.
  '28': 'exception',
  '31': 'out_for_delivery',
  '32': 'ready_for_pickup',
};

/**
 * The site's "utility" row: its delivery result names what happened. In
 * status group 4 that is an unsuccessful delivery and its reason; elsewhere
 * the result can be news such as an arrival or a delivery estimate.
 */
const UTILITY = '34';
const UNSUCCESSFUL = 4;

/** The final delivery code; its delivery result says who received the item. */
export const FINAL_DELIVERY = '35';
// The site's table gives code 35 two delivery results: S, the addressee's
// delivery, and L, the sender receiving the returned item.
const FINAL_RESULTS: Readonly<Record<string, Stage>> = { S: 'delivered', L: 'returned' };

// The status group (1 to 5) is the site's own category of every scan. It
// stands in for an unknown code only in group 3, the last mile, and group 4,
// an unsuccessful delivery or a withdrawn item. Group 1 also holds preload,
// group 2 customs and returns, and group 5 the COD payment to the seller
// after the delivery.
const GROUPS: Readonly<Record<number, Stage>> = {
  3: 'out_for_delivery',
  4: 'exception',
};

/** The delivery officer's call to the recipient. */
export const CONTACT_RECIPIENT = '57';
/** The COD amount paid to the seller after the delivery, in status group 5. */
export const COD_REMITTANCE = '36';
/** Activity that is not a milestone: it keeps the stage before it. */
export const ACTIVITY: ReadonlySet<string> = new Set([CONTACT_RECIPIENT, COD_REMITTANCE]);

/**
 * A scan's stage from its code (with, for a final delivery, its delivery
 * result, and for a utility row, its group). Other scans go to the shared
 * wording rules, then to their status group; a scan none of them knows stays
 * unmapped.
 */
export function thailandPostStage(code: string, label: string, group?: number | null, result = ''): ClassifiedWording | null {
  const mapped = code === FINAL_DELIVERY ? (Object.hasOwn(FINAL_RESULTS, result) ? FINAL_RESULTS[result] : undefined)
    : code === UTILITY ? (group === UNSUCCESSFUL ? 'failed_attempt' : undefined)
      : Object.hasOwn(CODES, code) ? CODES[code] : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  if (worded.source !== 'none') return worded;
  const grouped = group != null && Object.hasOwn(GROUPS, group) ? GROUPS[group] : undefined;
  return grouped ? { stage: grouped, source: 'carrier_map' } : null;
}

/**
 * The stage this map gives one scan by its code alone. A final delivery's
 * stage depends on its delivery result, a utility row's on its status group,
 * and other codes' on the shared wording rules and their group, so the map
 * does not answer for them.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && Object.hasOwn(CODES, code) ? CODES[code] : undefined),
  gaps: [
    { code: CONTACT_RECIPIENT, note: "The delivery officer's call to the recipient, not a movement: it keeps the stage of the scan before it." },
    { code: COD_REMITTANCE, note: 'The COD amount paid to the seller after the delivery, not a movement: it keeps the stage of the scan before it.' },
  ],
};
