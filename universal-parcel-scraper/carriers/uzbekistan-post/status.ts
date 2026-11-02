import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes of the tracker's replies. Items handled by Uzbekistan Post's
 * delivery system carry its status codes; EMS items, which the tracker reads
 * from the UPU's IPS, carry IPS event numbers. The two never overlap.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // A new item: taken in at a post office, announced by a shop or received from abroad.
  ['unassigned', 'registered'],
  ['in_sorting_facility', 'in_transit'],
  ['in_transit', 'in_transit'],
  // Sent on from an office, to the next one or with a postman.
  ['dispatched', 'in_transit'],
  // Ready to go out with a courier.
  ['ready_for_delivery', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['ready_for_issue', 'ready_for_pickup'],
  ['issued_to_recipient', 'delivered'],
  ['completed', 'delivered'],
  ['first_delivery_attempt', 'failed_attempt'],
  ['second_delivery_attempt', 'failed_attempt'],
  // The postman did not find the recipient at the address; the item can go out again.
  ['receiver_not_lives_there', 'failed_attempt'],
  ['incomplete_address', 'exception'],
  ['receiver_refuse', 'exception'],
  ['recipient_refused', 'exception'],
  ['cancelled_by_customer', 'exception'],
  ['returning_to_origin', 'returned'],
  ['returned_to_origin', 'returned'],
  ['sent_to_customs', 'customs'],
  // Released by customs, which sends the item on.
  ['returned_from_customs', 'in_transit'],
  // IPS events: the sending post's, then Uzbekistan Post's.
  ['1', 'accepted'],
  ['3', 'in_transit'],
  ['8', 'in_transit'],
  ['30', 'in_transit'],
  ['31', 'customs'],
  ['32', 'in_transit'],
  ['34', 'customs'],
  ['35', 'in_transit'],
  ['37', 'delivered'],
  ['38', 'in_transit'],
]);

/**
 * Wordings the tracker shows: the Russian names of IPS events, the English
 * name an event without one keeps, and the wordings of the tracker's former page.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Получение отправления от клиента', 'accepted'],
  ['Принято в пункте обмена', 'in_transit'],
  ['Отправление помещено в депешу для отправки в страну назначения', 'in_transit'],
  ['Отправлено на таможню', 'customs'],
  ['Выпущено из таможни', 'in_transit'],
  ['Отправлено в местный пункт', 'in_transit'],
  ['Отправлено в отделение доставки', 'in_transit'],
  ['Доставка отправления', 'delivered'],
  ['Receive item from customer (Otb)', 'accepted'],
  ['Receive item at office of exchange (Otb)', 'in_transit'],
  ['Insert item into bag (Otb)', 'in_transit'],
  ['Receive item at office of exchange (Inb)', 'in_transit'],
  ['Send item to customs (Inb)', 'customs'],
  // Customs recorded its status for the item; the scan's detail names it.
  ['Record item customs information (Inb)', 'customs'],
  ['Return item from customs (Inb)', 'in_transit'],
  ['Send item to domestic location (Inb)', 'in_transit'],
  ['Receive item at delivery office (Inb)', 'in_transit'],
  ['Deliver item (Inb)', 'delivered'],
  ['Не назначен', 'registered'],
  ['В сортировочном центре', 'in_transit'],
  ['В пути', 'in_transit'],
  ['Готов к выдаче', 'ready_for_pickup'],
  ['Выдан получателю', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// The detail the page shows beside an event, such as a reason customs kept the item.
const DETAIL = ': ';

/** The stage the map gives a scan's code, else its wording without the detail, if it knows either. */
export function uzbekistanPostMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording.split(DETAIL)[0]!));
}

/** A scan's stage from its code or wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function uzbekistanPostStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = uzbekistanPostMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The code sets the stage, else the wording; the map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => uzbekistanPostMappedStage(code, wording),
  gaps: [],
};
