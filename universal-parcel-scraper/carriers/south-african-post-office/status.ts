import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The Post Office's scan comments, mapped whole: the tracker's own, its
 * earlier tracker's and the list on the Post Office's Tracking Comments page.
 * `(Otb)` and `(Inb)` mark an outbound and an inbound leg.
 */
export const SOUTH_AFRICAN_POST_COMMENTS: Readonly<Record<string, Stage>> = {
  'Receive item from customer (Otb)': 'accepted',
  'Item accepted by branch': 'accepted',
  'Receive item at sorting centre': 'in_transit',
  'Receive item at location': 'in_transit',
  'Receive item at delivery office (Inb)': 'in_transit',
  Dispatched: 'in_transit',
  'In Transit': 'in_transit',
  // At the International Mail Centre, on the way in or out of the country.
  'Incoming International': 'in_transit',
  'Outgoing International': 'in_transit',
  // At the delivery office, before a notice goes out.
  'In Delivery Office': 'in_transit',
  'Item sent to Customs': 'customs',
  // Customs holds the item until the addressee sends an invoice.
  'Awaiting proof of purchase/value from addressee': 'customs',
  // Customs handed the item back to the post: cleared.
  'Returned from Customs': 'in_transit',
  // The same release in the tracker's words: the origin post and UPU's copy call the scan at
  // that minute a release from customs, and the item is dispatched from the mail centre next.
  'Handed over to customs authority for final delivery': 'in_transit',
  // A notice to collect the item at the office.
  'First Notification to recipient': 'ready_for_pickup',
  Delivered: 'delivered',
  'Item delivered': 'delivered',
  'AT OFFICE OF EXCHANGE OUT': 'in_transit',
  'AT OFFICE OF EXCHANGE IN': 'in_transit',
  'AT DELIVERY OFFICE IN': 'in_transit',
  'ATTEMPTED DELIVERY': 'failed_attempt',
  'AT CUSTOMS': 'customs',
  'BULK ACCEPTANCE': 'accepted',
  'CARD LEFT': 'failed_attempt',
  'DOC CALL': 'exception',
  'DETENTION NOTICE': 'customs',
  // The page explains it as the final notice to collect the item, not a delivery.
  'FINAL DELIVERY': 'ready_for_pickup',
  'FINAL NOTIFICATION': 'ready_for_pickup',
  'FIRST NOTIFICATION': 'ready_for_pickup',
  'HELD AT CUSTOMS': 'customs',
  'ITEM OUT POST OFFICE': 'in_transit',
  // The page explains it as the item accepted at the office it was posted at.
  'INSERT ITEM INTO BAG IN': 'accepted',
  'INSERT ITEM INTO BAG OUT': 'in_transit',
  'IN OFFICE': 'in_transit',
  // The delivery person's reason for not delivering.
  OTHER: 'failed_attempt',
  'RETURN ITEM FROM CUSTOMS': 'customs',
  'RETURN TO SENDER': 'returned',
  RETENTION: 'exception',
  'SENT TO DEL OFFICE IN': 'in_transit',
  'TO CUSTOMS': 'customs',
  // The Department of Health inspects the item at the International Mail Centre.
  'TO DOH': 'customs',
};

/**
 * The type the tracker files each scan under. It stages a scan whose comment
 * neither the map nor the shared rules know. At Office covers the arrival at
 * the delivery office as well as the notice to collect.
 */
export const SOUTH_AFRICAN_POST_TYPES: Readonly<Record<string, Stage>> = {
  Acceptance: 'accepted',
  'In Transit': 'in_transit',
  'At Office': 'in_transit',
  'Held In customs': 'customs',
  'Detention Notice': 'customs',
  'Delivered/Collected': 'delivered',
};

// A scanner's comment, with or without a dispatch number, is not a parcel event.
const NOTES = ['COMMENT', 'COMMENT, DISPATCH NUMBER'];

const keyed = (map: Readonly<Record<string, Stage>>) => new Map(Object.entries(map).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const COMMENTS = keyed(SOUTH_AFRICAN_POST_COMMENTS);
const TYPES = keyed(SOUTH_AFRICAN_POST_TYPES);
const GAPS = new Set(NOTES.map(normalizeStatusWording));
// "Delivered to : A NAME": the clause naming who took the item.
export const RECEIVER = /\s*\b(?:to|by)\s*:[\s\S]*$/i;

/** The stage the map gives a comment, without the clause naming who took the item. */
export function southAfricanPostCommentStage(wording: string): Stage | undefined {
  return COMMENTS.get(normalizeStatusWording(wording.replace(RECEIVER, '')));
}

/** The stage a scan's type gives, if the map knows it. */
export function southAfricanPostTypeStage(type: string): Stage | undefined {
  return TYPES.get(normalizeStatusWording(type));
}

/**
 * A scan's stage from its comment, else the shared wording rules, else its
 * type. A scanner's note has none, and so does a scan nothing knows, which
 * stays visible for review.
 */
export function southAfricanPostStage(comment: string, type: string): ClassifiedWording | null {
  if (GAPS.has(normalizeStatusWording(comment))) return null;
  const mapped = comment ? southAfricanPostCommentStage(comment) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (comment) {
    const worded = classifyWording(comment, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  const typed = type ? southAfricanPostTypeStage(type) : undefined;
  return typed ? { stage: typed, source: 'carrier_map' } : null;
}

/** The scans carry wording only; a scan without a comment shows its type. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code || GAPS.has(wording) ? undefined
    : southAfricanPostCommentStage(wording) ?? southAfricanPostTypeStage(wording)),
  gaps: NOTES.map((wording) => ({ wording: normalizeStatusWording(wording),
    note: 'A scanner\'s comment, which the Post Office\'s Tracking Comments page lists; it is not a parcel event.' })),
};
