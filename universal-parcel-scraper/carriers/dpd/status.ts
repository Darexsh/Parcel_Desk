/**
 * DPD Switzerland status vocabulary.
 *
 * Three sources have to agree here. The myDPD guest API answers with a
 * `parcelHistory[].description` / `status.description` enumeration
 * (`DELIVERED`, `AVAILABLE_FOR_COLLECTION`, ...), which is the reliable key. A
 * verified-postcode lookup adds `parcelEvents[].eventType` scan codes (`DEY`,
 * `DLO`, ...). The rendered consignee page has no codes at all, only
 * translated prose, so the page fallback is classified by wording in four
 * languages.
 *
 * Only the values whose meaning is unambiguous receive an explicit stage.
 * `PARCEL_HANDED`, `IN_TRANSIT` and `AT_DELIVERY_CENTER` deliberately yield no
 * stage: they move the result status to `in_transit` but leave the event
 * unmapped so the sync's classifier records the wording for review instead of
 * this map inventing a milestone. Scan codes are mapped where a live lookup
 * paired them with an enumeration value, or where DPD's own label names one
 * movement inside its network (see `scanStage`). `statusMap` lists the codes
 * and labels left unmapped on purpose.
 *
 * Provenance: the enumeration, the scan codes and their English labels are
 * what the myDPD guest API returns for Swiss consignee lookups; the wording
 * lists come from the public tracking page in en/de/fr/it.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { deliveryForecastRemainder } from '../../core/status/language.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** English labels for the guest API enumeration, used when the API sends no translation. */
export const API_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PARCEL_HANDED: 'Parcel handed to DPD',
  IN_TRANSIT: 'Your parcel is on its way',
  AT_DELIVERY_CENTER: 'At delivery center',
  RETURN_TO_SENDER: 'Return to sender',
  PARCEL_OUT_FOR_DELIVERY: 'Parcel out for delivery',
  AVAILABLE_FOR_COLLECTION: 'Ready for collection',
  UNSUCCESSFUL_DELIVERY_ATTEMPT: 'Unsuccessful delivery attempt',
  DELIVERED: 'Delivered',
  OTHER: 'Other tracking update',
};

/** Wording classifier for the rendered page, which carries no status codes. */
export function wordingStatus(text: string, hasEvents: boolean): CarrierStatus {
  // A delivery notice ("will be delivered on Tuesday") is not a delivery.
  const value = (deliveryForecastRemainder(text) ?? text).toLocaleLowerCase('en-US');
  if (['failed', 'not delivered', 'unable', 'problem', 'retour', 'returned']
    .some((term) => value.includes(term))) return 'exception';
  if (['delivered', 'zugestellt', 'livré', 'consegnato']
    .some((term) => value.includes(term))) return 'delivered';
  if (['out for delivery', 'delivery today', 'in zustellung', 'en cours de livraison']
    .some((term) => value.includes(term))) return 'out_for_delivery';
  if (hasEvents || ['handed to dpd', 'on its way', 'arrived', 'depot', 'network']
    .some((term) => value.includes(term))) return 'in_transit';
  if (['data received', 'information received', 'announced', 'übergeben']
    .some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

/** The result status for a guest API enumeration value, falling back to the wording. */
export function apiStatus(description: unknown, statusText: string, hasEvents: boolean): CarrierStatus {
  const key = typeof description === 'string' ? description.trim().toUpperCase() : '';
  if (key === 'DELIVERED') return 'delivered';
  if (['PARCEL_OUT_FOR_DELIVERY', 'AVAILABLE_FOR_COLLECTION'].includes(key)) {
    return 'out_for_delivery';
  }
  if (['RETURN_TO_SENDER', 'UNSUCCESSFUL_DELIVERY_ATTEMPT'].includes(key)) {
    // A failed attempt is a retry, not terminal; a return is terminal but
    // stays in the exception status with a returned stage (no returning status).
    return key === 'RETURN_TO_SENDER' ? 'exception' : 'in_transit';
  }
  if (key === 'ORDER_CREATED') return 'pending';
  if (['PARCEL_HANDED', 'IN_TRANSIT', 'AT_DELIVERY_CENTER'].includes(key)) return 'in_transit';
  return wordingStatus(statusText, hasEvents);
}

/** The stage for a guest API enumeration value, or null when the value is not mapped. */
export function apiStage(description: unknown): Stage | null {
  const key = typeof description === 'string' ? description.trim().toUpperCase() : '';
  if (key === 'AVAILABLE_FOR_COLLECTION') return 'ready_for_pickup';
  if (key === 'PARCEL_OUT_FOR_DELIVERY') return 'out_for_delivery';
  if (key === 'RETURN_TO_SENDER') return 'returned';
  if (key === 'UNSUCCESSFUL_DELIVERY_ATTEMPT') return 'failed_attempt';
  if (key === 'ORDER_CREATED') return 'registered';
  if (key === 'DELIVERED') return 'delivered';
  return null;
}

/**
 * `parcelEvents[].eventType` scan codes. On 2026-09-26 a verified lookup
 * listed ORI, DLI, DLO and DEY at the same wall clock as the `parcelHistory`
 * enumeration named beside them. CCO has no twin; it ends customs clearance.
 * HUI, HUS, DLS and DLQ are the hub and delivery-depot scans a verified
 * domestic history lists between ORI and DLO, each labelled with one movement.
 * A German history adds SPX before the line haul, the failed rounds DEX, DLR
 * and DLW, and the pickup-point scans: DEHD and DEHDY when the parcel reaches
 * the point, DODEI (twin AVAILABLE_FOR_COLLECTION) and the notice DOMSDLO when
 * it waits there, DODEY (twin DELIVERED) when the recipient collects it.
 * PKY is the driver collecting the parcel from its sender, before ENA's data
 * exchange ends and the parcel reaches the origin depot. A German parcel the
 * sender left at a pickup point opens with CNP, DPD receiving its label data,
 * then DOPKY for the hand-in at the point, DODEH when the driver collects it
 * there, and ORS, worded like HUS, as the origin depot sends it on.
 * LHI, worded like IN_TRANSIT, comes between the hub and the delivery depot;
 * DEXD is a round that ended at a pickup point with no space for the parcel.
 * ORI ("Origin depot - In") stays unmapped like its twin PARCEL_HANDED: the
 * result stage then comes from the same wording as the scan's, and an import
 * that cleared customs does not step back to accepted. Other codes stay
 * unmapped.
 */
const SCAN_STAGES: Readonly<Record<string, Stage>> = {
  CNP: 'registered', // "We received your labelling information", before the parcel moves
  PKY: 'accepted', // "We have collected your parcel", the pickup from the sender
  DOPKY: 'accepted', // "Your parcel has been dropped off in the retrieval point", the sender's hand-in
  DODEH: 'in_transit', // "Your parcel has been collected by the driver from the retrieval point"
  ORS: 'in_transit', // "Your parcel is ready to be transported to our next premises"
  CCO: 'in_transit', // "Customs - Out"
  SPX: 'in_transit', // "Your parcel is on our premises, it will soon be on its way"
  HUI: 'in_transit', // "Your parcel arrived at our hub"
  HUS: 'in_transit', // "Your parcel is ready to be transported to our next premises"
  LHI: 'in_transit', // "Your parcel is on its way", between the hub and the delivery depot
  DLI: 'in_transit', // "Destination depot - Inbound", twin AT_DELIVERY_CENTER
  DLS: 'in_transit', // "Your parcel has been sorted and is ready for delivery"
  DLQ: 'in_transit', // "Your parcel is at our delivery depot, it will soon be on its way"
  DLO: 'out_for_delivery', // "Destination depot - Out for delivery", twin PARCEL_OUT_FOR_DELIVERY
  DEX: 'failed_attempt', // "We couldn't deliver your parcel, it will soon be available at a retrieval point"
  DEXD: 'failed_attempt', // "There was an issue to drop off your parcel due to a lack of space in the retrieval point"
  DLR: 'failed_attempt', // "We couldn't deliver your parcel and had to return it to the depot"
  DLW: 'failed_attempt', // "Your parcel is being held at our delivery depot, your premises were closed"
  DEHD: 'ready_for_pickup', // "Your parcel has been delivered to the retrieval point, it will soon be available for collection"
  DEHDY: 'ready_for_pickup', // "Your parcel has been delivered to the retrieval point"
  DODEI: 'ready_for_pickup', // "Your parcel is available at the retrieval point", twin AVAILABLE_FOR_COLLECTION
  DOMSDLO: 'ready_for_pickup', // The same wording as DODEI, sent as a notice without a place
  DEY: 'delivered', // "Delivery - Delivered", twin DELIVERED
  DODEY: 'delivered', // "You have collected your parcel", twin DELIVERED
};

/** The stage for a guest API scan code, or null when the code is not mapped. */
export function scanStage(code: string): Stage | null {
  return Object.hasOwn(SCAN_STAGES, code) ? SCAN_STAGES[code]! : null;
}

/**
 * "Delivery - Proof of delivery": DPD filing the proof minutes after DEY,
 * with no place. Paperwork, not a movement of the parcel.
 */
export const PROOF_OF_DELIVERY_SCAN = 'DEYY';

/**
 * Notices that would move the parcel: MSDLX, DPD failing to send the delivery
 * details, reads as a failed round, and the others as in transit to an app
 * that takes such a scan as news that the parcel moves. ENA is a data exchange
 * inside DPD's systems; SPE a delivery estimate or a changed delivery day; MSDLO
 * the notice DPD emailed for the delivery round; MIDLI and MII the recipient's
 * delivery instruction and MIA its receipt, which can come while DPD has only
 * the label; OTHER the guest API's catch-all. Each keeps the stage of the scan
 * before it.
 */
export const NOTICE_SCANS: ReadonlySet<string> = new Set(['MSDLX', 'ENA', 'SPE', 'MSDLO', 'MIDLI', 'MII', 'MIA', 'OTHER']);

const MOVES_WITHOUT_MILESTONE = "DPD's map leaves it unmapped on purpose: it moves the parcel in transit without a milestone of its own.";

/**
 * What the map says about one scan. A scan code or an enumeration value is all
 * it reads: the rendered page's prose has no code and gets no stage here, and
 * a code staged by its enumeration twin depends on the reply, so it is not
 * answered by the code alone.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? scanStage(code) ?? apiStage(code) : null) ?? undefined,
  gaps: [
    { code: 'PARCEL_HANDED', note: MOVES_WITHOUT_MILESTONE },
    { code: 'IN_TRANSIT', note: MOVES_WITHOUT_MILESTONE },
    { code: 'AT_DELIVERY_CENTER', note: MOVES_WITHOUT_MILESTONE },
    { code: 'ORI', note: "DPD's map leaves it unmapped on purpose, like its twin PARCEL_HANDED, so an import that cleared customs does not step back to accepted." },
    { wording: 'parcel handed to dpd', note: "The label of PARCEL_HANDED, which DPD's map leaves unmapped on purpose." },
    { wording: 'your parcel is on its way', note: "The label of IN_TRANSIT, which DPD's map leaves unmapped on purpose." },
    { wording: 'at delivery center', note: "The label of AT_DELIVERY_CENTER, which DPD's map leaves unmapped on purpose." },
    { code: 'SPL', note: 'Worded like IN_TRANSIT and seen on both sides of the origin depot, so it names no movement of its own.' },
    { code: 'OTHER', note: "The guest API's catch-all, which names no movement: the parcel keeps the stage it had." },
    { code: 'SPE', note: 'A delivery estimate or a changed delivery day, not a scan: the parcel keeps the stage it had.' },
    { code: 'MSDLO', note: 'The notice DPD emailed for the delivery round, not a scan: the parcel keeps the stage it had.' },
    { code: 'MSDLX', note: 'DPD failing to send the delivery details, not a scan: the parcel keeps the stage it had.' },
    { code: 'MIDLI', note: "The recipient's delivery instruction, not a scan: the parcel keeps the stage it had." },
    { code: 'MIA', note: "The receipt of the recipient's delivery instruction, not a scan: the parcel keeps the stage it had." },
    { code: 'MII', note: "The recipient's delivery instruction, as MIDLI words it, not a scan: the parcel keeps the stage it had." },
    { wording: 'your parcel will be delivered to a safe place according to your instructions', note: "The label of MII and MIDLI, the recipient's delivery instruction: the parcel keeps the stage it had." },
    { wording: 'we received your delivery instructions', note: "The label of MIA, the receipt of the recipient's delivery instruction: the parcel keeps the stage it had." },
    { code: 'ENA', note: "A data exchange inside DPD's systems before the parcel reaches the origin depot, not a scan: the parcel keeps the stage it had." },
    { code: 'DEYY', note: 'The proof of delivery, paperwork after the delivery scan: dropped beside it, delivered alone only when the enumeration says so.' },
    { code: 'DODEYY', note: 'The proof of delivery after a collection from a pickup point, read like DEYY.' },
  ],
};
