import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Direx's status codes, as its tracking lookup and its API documentation give
 * them. The lookup names a status in English whatever the page's language.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['CRD', 'registered'], // Created: the sender made the shipment.
  ['APO', 'accepted'], // Accepted by Direx at its warehouse.
  ['DED', 'in_transit'], // Dispatched to the partner.
  ['ITT', 'in_transit'],
  ['ADC', 'in_transit'], // In Destination Country.
  ['DAT', 'failed_attempt'],
  ['DLD', 'delivered'],
  ['RND', 'returned'], // Returned: on its way back.
  ['RCD', 'returned'], // Return Completed.
  ['RWD', 'returned'], // Returned shipment by partner.
  ['RAD', 'returned'], // The returned parcel is in a dispatch back to the sender.
]);

/**
 * The tracker's names for its statuses, in English and in Bulgarian as the
 * former tracking page's message table gives them, for a status that comes
 * with a code the map does not know or without one.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Created', 'registered'],
  ['Създадена', 'registered'],
  // The sender sent the parcel to Direx, which does not have it yet.
  ['The shipment was sent to Direx', 'registered'],
  ['Пратката е изпратена към Direx', 'registered'],
  ['Accepted by Direx', 'accepted'],
  ['Приета от Direx', 'accepted'],
  ['Dispatched', 'in_transit'],
  ['Изпратена', 'in_transit'],
  ['Sent to partner hub', 'in_transit'],
  ['Изпратена към склада на партньора', 'in_transit'],
  ['Arrived at Transit Point', 'in_transit'],
  ['Пристигнала в транзитен пункт', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['В транзит', 'in_transit'],
  ['Departed Transit Country', 'in_transit'],
  ['Processing at Partner', 'in_transit'],
  ['In Destination Country', 'in_transit'],
  ['В страна на получател', 'in_transit'],
  ['Delivery Attempt', 'failed_attempt'],
  ['Опит за доставка', 'failed_attempt'],
  ['Delivered', 'delivered'],
  ['Доставена', 'delivered'],
  ['Returned', 'returned'],
  ['Return Completed', 'returned'],
  ['Returned shipment by partner', 'returned'],
  ['Върната пратка от партньор', 'returned'],
  ['Returned to customer', 'returned'],
  ['Върната пратка на клиент', 'returned'],
  ['Returned shipment added to expedition', 'returned'],
  ['Върната пратка добавена в експедиция', 'returned'],
  // The partner sends the parcel back.
  ['Scheduled return by partner', 'returned'],
  ['Планирано връщане от партньор', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a code, else a wording, if it knows either. */
export function direxMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A status's stage from its code or name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function direxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = direxMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map leaves no code or name out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => direxMappedStage(code, wording),
  gaps: [],
};
