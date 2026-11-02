import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes DobroPost's tracker gives its own scans, from the China warehouse
 * through customs, and the codes it relays from the domestic carrier that
 * takes the last leg: CDEK's (RECEIVED_AT_SHIPMENT_WAREHOUSE to DELIVERED) and
 * Boxberry's (ACCEPTED_FOR_DELIVERY to RETURNED). Only codes seen in replies
 * are mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // At DobroPost's warehouse in China, which holds the customer's goods.
  ['ON_ASSEMBLY', 'accepted'], // The goods are packed into one parcel.
  ['ON_WEIGHING', 'accepted'],
  ['AWAITING_PAYMENT', 'accepted'], // The customer pays the shipping.
  ['READY_FOR_SENT', 'accepted'],
  ['ADDED_TO_THE_REGISTRY', 'accepted'], // Put on a dispatch manifest; the wording leaves its number out.
  ['LEFT_THE_DP_WERHOUSE_IN_CHINA', 'in_transit'],
  ['AT_CUSTOMS_IN_CHINA', 'customs'], // Export clearance.
  ['FLEW_OUT_FROM_CHINA', 'in_transit'],
  ['ARRIVED_AT_CUSTOMS_IN_THE_COUNTRY_OFF_DESTINATION', 'customs'],
  ['START_OF_CUSTOMS_CLEARANCE', 'customs'],
  ['RELEASE_OF_GOODS_WITHOUT_PAYMENT_OF_CUSTOMS_DUTIES', 'in_transit'],
  // Customs refused the release and gives the reason, such as goods not for personal use.
  ['REFUSAL_TO_RELEASE_GOODS_WITH_INDICATION_OF_THE_CODE_OF_THE_REASON_FOR_REFUSAL', 'exception'],
  ['READY_FOR_SHIPMENT_FOR_LAST_MILE_DELIVERY', 'in_transit'],
  ["LEFT_CUSTOMS_AND_HEADING_TO_LAST_MILE_CARRIER'S_WAREHOUSE", 'in_transit'],
  ['PARCEL_DELIVERED_TO_RECIPIENT', 'delivered'],
  // CDEK's codes.
  ['RECEIVED_AT_SHIPMENT_WAREHOUSE', 'in_transit'],
  ['READY_TO_SHIP_AT_SENDING_OFFICE', 'in_transit'],
  ['PASSED_TO_CARRIER_AT_SENDING_OFFICE', 'in_transit'],
  ['SEND_TO_TRANSIT_OFFICE', 'in_transit'],
  ['MET_AT_TRANSIT_OFFICE', 'in_transit'],
  ['ACCEPTED_TO_OFFICE_TRANSIT_WAREHOUSE', 'in_transit'],
  ['READY_TO_SHIP_IN_TRANSIT_OFFICE', 'in_transit'],
  ['PASSED_TO_CARRIER_AT_TRANSIT_OFFICE', 'in_transit'],
  ['SEND_TO_RECIPIENT_OFFICE', 'in_transit'],
  ['MET_AT_RECIPIENT_OFFICE', 'in_transit'],
  // "Принят на склад до востребования": waiting at the office for collection,
  // although the tracker files it with the deliveries.
  ['ACCEPTED_AT_WAREHOUSE_ON_DEMAND', 'ready_for_pickup'],
  ['DELIVERED', 'delivered'],
  // Boxberry's codes.
  ['ACCEPTED_FOR_DELIVERY', 'in_transit'],
  ['TRANSFERRED_FOR_SORTING', 'in_transit'],
  ['SENT_TO_DESTINATION_CITY', 'in_transit'],
  ["IN_THE_RECIPIENT'S_CITY", 'in_transit'],
  ['TRANSFERRED_FOR_DELIVERY_TO_THE_PICKUP_POINT', 'in_transit'],
  ['RECEIVED_AT_THE_POINT_OF_ISSUE', 'ready_for_pickup'],
  ['GETTING_READY_TO_RETURN', 'returned'], // Not collected; it goes back to DobroPost.
  ['SENT_TO_COLLECTION_POINT', 'returned'],
  ['RETURNED_TO_COLLECTION_POINT', 'returned'],
  ['RETURNED', 'returned'], // "Возвращено в ИМ": back with DobroPost, which can send it again.
]);

// Its wording decides: the tracker has shown it as "Возврат в Китай разрешен"
// after customs refused a release, when the parcel went back to China.
const RELEASE_PAID = 'RELEASE_OF_GOODS_CUSTOMS_PAYMENTS_PAID';
const RETURN = /^возврат/;

/**
 * Russian Post's operations, relayed without a code, and a wording DobroPost
 * quotes for its own tracker.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['прием', 'in_transit'], // Russian Post took the parcel for the last leg.
  ['обработка', 'in_transit'],
  ['досылка почты', 'in_transit'], // Sent on to another address.
  ['возврат', 'returned'],
  ['вручение', 'delivered'],
  ['выпуск с таможни', 'customs'],
]);

/**
 * The tracker's own category for a scan, which it puts beside every code.
 * Categories that mix stages (China shipping, clearance, delivery) are left
 * out; this only stages a code or wording the maps above do not know.
 */
const CATEGORIES: ReadonlyMap<number, Stage> = new Map([
  [1, 'accepted'], [2, 'accepted'], [3, 'accepted'], [4, 'accepted'],
  [6, 'in_transit'], [8, 'exception'], [10, 'ready_for_pickup'], [12, 'customs'], [13, 'in_transit'],
  [14, 'returned'], [16, 'returned'],
]);

// "Удалён на Шипторе": the order at Shiptor, the last-mile service, was deleted. The parcel does not move.
const DELETED = 'DELETED_ON_SHIPTOR';
const DELETED_CATEGORY = 100;

/** The stage DobroPost's maps give a code (null without one) and a wording in `normalizeStatusWording` form. */
export function dobropostMappedStage(code: string | null, wording: string): Stage | undefined {
  if (code === RELEASE_PAID) return RETURN.test(wording) ? 'returned' : 'in_transit';
  if (code) return CODES.get(code);
  return WORDINGS.get(wording);
}

/** A scan's stage: its code or wording, else the tracker's category, else nothing. */
export function dobropostStage(code: string, wording: string, category: number | null): ClassifiedWording | null {
  if (code === DELETED || category === DELETED_CATEGORY) return null;
  const stage = dobropostMappedStage(code || null, normalizeStatusWording(wording)) ?? (category === null ? undefined : CATEGORIES.get(category));
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: dobropostMappedStage,
  gaps: [
    { code: DELETED, note: 'The order at Shiptor, the last-mile service, was deleted; the parcel itself does not move.' },
  ],
};
