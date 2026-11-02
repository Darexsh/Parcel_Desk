import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The kind of scan CouriersPlease's tracker gives each row (`nodeType`). Only
 * kinds seen in replies are mapped. `faildeliver` covers failed attempts as
 * well as parcels held for a problem or refused, so its wording comes first;
 * `status` rows are notes whose wording alone can stage them.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['manifest', 'registered'], // Shipment information received from the sender.
  ['pickup', 'accepted'],
  ['futile', 'exception'], // A pickup attempt at the sender failed.
  ['reweigh', 'in_transit'], // Arrived at a facility for processing.
  ['transit', 'in_transit'], // In transit between delivery centres.
  ['deconsolidate', 'in_transit'], // Arrived at the delivery centre.
  ['indepot', 'in_transit'], // Processed at the delivery centre.
  ['agent', 'in_transit'], // Handed to a regional delivery partner.
  ['accept', 'out_for_delivery'], // Onboard for delivery.
  ['offboard-depot', 'failed_attempt'], // Back at the depot undelivered; rescheduled for the next business day.
  ['faildeliver', 'failed_attempt'],
  ['deliver', 'delivered'],
]);

/** A wording in `normalizeStatusWording` form, with dashes made plain and no closing full stop. */
function key(wording: string): string {
  return normalizeStatusWording(wording).replace(/\s*[–—]\s*/g, ' - ').replace(/[\s.]+$/, '');
}

/**
 * The help centre's statuses, by their whole wording. They come before the
 * row's kind, which several of them share.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Shipment information received', 'registered'],
  ['Your parcel has been picked up', 'accepted'],
  ['Received at Collection Point and awaiting collection by our driver', 'accepted'],
  ['Pickup attempt was unsuccessful', 'exception'],
  ['Pickup attempt was unsuccessful. Awaiting rebook confirmation by sender', 'exception'],
  ['Arrived at facility for processing', 'in_transit'],
  ['Processed at delivery centre', 'in_transit'],
  ['In transit to delivery centre', 'in_transit'],
  ['Arrived at delivery centre', 'in_transit'],
  ['On the way to our delivery partner', 'in_transit'],
  ['In transit to regional delivery centre', 'in_transit'],
  ['Incomplete Shipment Received', 'in_transit'],
  ['In Transit with Couriers Please', 'in_transit'],
  ['Processing for collection at a nearby collection point', 'in_transit'],
  ['Onboard for delivery', 'out_for_delivery'],
  ['Resent for delivery', 'out_for_delivery'],
  ['Delivery rescheduled for next business day', 'failed_attempt'],
  ['Delivery attempted – Signature required', 'failed_attempt'],
  ['Delivery attempted – Signature required – Redirected to a collection point', 'failed_attempt'],
  ['Delivery attempted – Unsafe to leave', 'failed_attempt'],
  ['Delivery attempted – Unsafe to leave – Sent to a collection point', 'failed_attempt'],
  ['Delivery attempted – Business was closed', 'failed_attempt'],
  ['Delivery attempted – Additional address information required', 'exception'],
  ['Unable to deliver', 'exception'],
  ['Delivery attempted – Delivery refused by receiver', 'returned'],
  ['Pickup at Collection Point – Ready for collection', 'ready_for_pickup'],
  ['Depot collection arranged', 'ready_for_pickup'],
  ['Parcel has been collected from the collection point', 'delivered'],
  ['Collected from Depot', 'delivered'],
  ['Delivered', 'delivered'],
  ['Delivered with Authority to Leave (ATL)', 'delivered'],
  ['Collection period expired – Return to sender in progress', 'returned'],
  ['Return to Sender In Progress', 'returned'],
] as const).map(([wording, stage]) => [key(wording), stage]));

/**
 * Notices the help centre lists that move nothing: a new delivery date or the
 * receiver's instructions for the delivery still to come.
 */
const NOTICES = [
  ['Delivery rescheduled', 'A new delivery date, which tracking shows; the parcel does not move.'],
  ['Delivery instructions – Rescheduled', 'The receiver chose a new delivery date; it moves nothing.'],
  ['Delivery instructions – Collection point', 'The receiver redirected the parcel to a collection point; the parcel has not moved yet.'],
  ['Delivery instructions – Leave with Neighbour', 'An instruction for the delivery still to come; it moves nothing.'],
  ['Delivery instructions – Authority to Leave (ATL)', 'An instruction for the delivery still to come; it moves nothing.'],
  ['Delivery instructions – New delivery address', 'An instruction for the delivery still to come; it moves nothing.'],
] as const;
const NOTES: ReadonlySet<string> = new Set(NOTICES.map(([wording]) => key(wording)));

/** The stage CouriersPlease's vocabulary gives a row's wording, else its kind. */
export function couriersPleaseMappedStage(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(key(wording)) ?? (code ? CODES.get(code.toLowerCase()) : undefined);
}

/** A scan's stage: its wording or kind, else the shared wording rules, else nothing. */
export function couriersPleaseStage(code: string, wording: string): ClassifiedWording | null {
  if (NOTES.has(key(wording))) return null;
  const mapped = couriersPleaseMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (NOTES.has(key(wording)) ? undefined : couriersPleaseMappedStage(code, wording)),
  gaps: NOTICES.map(([wording, note]) => ({ wording: normalizeStatusWording(wording), note })),
};
