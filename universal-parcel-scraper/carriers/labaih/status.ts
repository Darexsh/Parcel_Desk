import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const key = normalizeStatusWording;

/**
 * LaBaih's scan wordings, in English as the adapter reads them and in Arabic
 * as the default page shows them. The tracker shows no codes. A parcel is
 * collected from the online shop that sends it, arrives at a city's
 * distribution centre and goes out to the customer from there.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  [key('Shipment created'), 'registered'],
  [key('تم إنشاء الشحنة'), 'registered'],
  [key('Shipment Collected From Partner'), 'accepted'],
  [key('تم استلام الشحنة من الشريك'), 'accepted'],
  // Back at the distribution centre after an attempt; the Arabic page words it as an arrival there.
  [key('Returned To Facility'), 'in_transit'],
  [key('وصلت الشحنة إلى مركز التوزيع'), 'in_transit'],
  [key('In-Transit to Customer'), 'out_for_delivery'],
  [key('الشحنة في طريقها إلى العميل'), 'out_for_delivery'],
  [key('Unsuccessful Delivery'), 'failed_attempt'],
  [key('محاولة توصيل غير ناجحة'), 'failed_attempt'],
  [key('Shipment Delivered'), 'delivered'],
  [key('تم توصيل الشحنة'), 'delivered'],
]);

// An arrival at a city's distribution centre: "Arrived at Riyadh Facility", or in Arabic with "بـ" and the city.
const ARRIVED = /^(?:arrived at \S.* facility|وصلت الشحنة إلى مركز التوزيع بـ\S.*)$/u;

// A failed attempt keeps the reason the page gives after a colon: "Unsuccessful Delivery: Waiting time exceed".
const FAILED = /^(?:unsuccessful delivery|محاولة توصيل غير ناجحة):/u;

// Messages about the delivery location, which move nothing.
const NOTICES = [
  'SMS sent requesting location to customer',
  'Customer sent location',
  'العميل قام بإرسال إحداثيات التوصيل',
].map(key);

/** The stage LaBaih's wordings give a scan, in `normalizeStatusWording` form or as shown. */
export function labaihMappedStage(wording: string): Stage | undefined {
  const normalized = key(wording);
  return WORDINGS.get(normalized) ?? (ARRIVED.test(normalized) ? 'in_transit' : FAILED.test(normalized) ? 'failed_attempt' : undefined);
}

/** A scan's stage: LaBaih's wordings, else the shared wording rules, else nothing. */
export function labaihStage(wording: string): ClassifiedWording | null {
  const mapped = labaihMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.includes(key(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : labaihMappedStage(wording)),
  gaps: NOTICES.map((wording) => ({ wording, note: 'A message asking for, or giving, the delivery location; the parcel does not move.' })),
};
