import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The public website's SendungenApiSchemasExtension distinguishes the summary
// vocabulary from scan codes: a delivered scan can still carry status IZ.
const SUMMARY: Record<string, ClassifiedStatus> = {
  AV: { status: 'pending', stage: 'registered' },
  AN: { status: 'in_transit', stage: 'accepted' },
  IV: { status: 'in_transit', stage: 'in_transit' },
  IZ: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  EB: { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  RE: { status: 'exception', stage: 'returned' },
  ZU: { status: 'delivered', stage: 'delivered' },
};

export function austrianPostSummaryStatus(code: string): ClassifiedStatus | undefined {
  return SUMMARY[code];
}

// The reasons for which the tracking page shows a delay (its Verzoegerung
// list) or a problem to resolve (Rufzeichen) instead of the estimate.
const ESTIMATE_HIDDEN = new Set([
  'AB', 'BC', 'BF', 'BS', 'EL', 'ELE', 'ET', 'FL', 'FT', 'GF', 'GG', 'HG', 'IF', 'NS', 'SH', 'SN', 'TG', 'XAV', 'XEU', 'XFA', 'XNB',
  'AC', 'AH', 'AM', 'AN', 'AV', 'AW', 'AX', 'CAC', 'CAF', 'CAH', 'CAM', 'CAN', 'CAV', 'CAW', 'CAX', 'CEU', 'CEV', 'CFA', 'CFU',
  'CGG', 'CIF', 'CNK', 'CNN', 'CNR', 'CNU', 'COS', 'CSH', 'CST', 'CTG', 'EU', 'EV', 'FA', 'FB', 'FU', 'FX', 'KG', 'NB', 'NN',
  'NR', 'NV', 'NZ', 'OB', 'OS', 'OV', 'OW', 'OX', 'PF', 'WD', 'ZVE', '2055', '2065',
]);

/**
 * Whether the tracking page shows the delivery estimate, given the summary
 * code and the newest scan's reason: only while the item is accepted, in
 * distribution or out for delivery, and not after one of those reasons or a
 * missed delivery.
 */
export function austrianPostShowsEstimate(summary: string, newestReason: string): boolean {
  if (summary !== 'AN' && summary !== 'IV' && summary !== 'IZ') return false;
  if (summary === 'IZ' && (newestReason === 'BH' || newestReason === 'BN')) return false;
  return !ESTIMATE_HIDDEN.has(newestReason);
}

// A delivery's wording. The recipient taking the parcel out of a Post
// Empfangsbox (reason ZPB) is its delivery, which the page sums up as ZU
// although the scan carries status IZ; putting it in the box (UPB or 2034)
// made it ready for collection, as the page's summary EB then says.
const DELIVERED = /\b(?:wurde zugestellt|aus postempfangsbox abgeholt|successfully delivered)\b/i;

// Scans of an item another post sends to Austria: the sending post's posting
// and dispatch, as Austrian Post relays them, then its own processing once the
// item arrives. A letter put through the letterbox is delivered.
const WORDINGS: Readonly<Record<string, ClassifiedStatus | undefined>> = {
  'postaufgabe im ausland': SUMMARY.AN,
  'sendung in bearbeitung aufgabeland': SUMMARY.IV,
  'sendung für auslandstransport bereit': SUMMARY.IV,
  'sendung ins zielland unterwegs': SUMMARY.IV,
  'sendung in bearbeitung österreich': SUMMARY.IV,
  eingeworfen: SUMMARY.ZU,
};
const byWording = (text: string) => WORDINGS[text.trim().toLowerCase()];
// Customs scans of an item from abroad: the declaration under way (CUS), the item
// stored while an obstacle to the declaration stands (LAG), a delay in customs
// with its reason after "Grund:" (CUD), and the recipient's reply to the
// obstacle (SN). The tracking page meanwhile asks the recipient for the
// missing documents.
const CUSTOMS = /^(?:sendung im zollanmeldungsprozess\. weitere info folgt\.|lagereingang - zollanmeldungshindernis|sendung ist im zollprozess verzögert\. grund: .+|zollanmeldungshindernis - rückmeldung vom empfänger eingelangt)$/iu;
const customsScan = (text: string) => CUSTOMS.test(text.trim().split(/\s+/).join(' '));
const HELD_IN_CUSTOMS: ClassifiedStatus = { status: 'in_transit', stage: 'customs' };
const RETURNING = /\b(?:rücksendung|zurückgesandt|return to sender)\b/i;
const OUT_FOR_DELIVERY = /\b(?:in zustellung|out for delivery)\b/i;

export function austrianPostEventStatus(code: string, reason: string, text: string): ClassifiedStatus | undefined {
  if (reason === 'ZA' || reason === 'ZPB' || DELIVERED.test(text) || byWording(text)?.stage === 'delivered') return SUMMARY.ZU;
  if (['BH', 'BN', 'HB', 'NZ', '2055', '2065'].includes(reason)) return { status: 'exception', stage: 'failed_attempt' };
  if (['EAW', 'HO', 'UPB', '2034'].includes(reason)) return SUMMARY.EB;
  if (RETURNING.test(text)) return SUMMARY.RE;
  if (code === 'AZT' || OUT_FOR_DELIVERY.test(text)) return SUMMARY.IZ;
  // IMP is the arrival in the destination country, which the page files under distribution.
  if (code === 'BEI' || code === 'PUG' || code === 'IMP' || transitScan(code, text)) return SUMMARY.IV;
  if (customsScan(text)) return HELD_IN_CUSTOMS;
  // Unmapped scan codes retain their wording for the host's classifier.
  return byWording(text) ?? SUMMARY[code];
}

/** A transit scan: the export hub gathers the item into an outgoing dispatch, or the item is in transit. */
function transitScan(code: string, text: string): boolean {
  return code === 'TRA' && /^(?:konsolidierung für (?:den )?export|transit)$/i.test(text.trim());
}

/**
 * What the map says about one scan by its code and wording. Most scans take
 * their stage from the reason as well (an IZ scan with reason BH is a missed
 * delivery), so the map answers only scans the reason cannot change: a
 * delivery's wording, the transit scans, the arrival in the destination
 * country (IMP), with or without wording unless it names a return or a
 * delivery round, which outrank the code, the customs scans and the wordings
 * above.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (DELIVERED.test(wording)) return 'delivered';
    if (code === 'IMP' && !RETURNING.test(wording) && !OUT_FOR_DELIVERY.test(wording)) return 'in_transit';
    if (code && transitScan(code, wording)) return 'in_transit';
    if (customsScan(wording)) return 'customs';
    return byWording(wording)?.stage;
  },
  gaps: [],
};
