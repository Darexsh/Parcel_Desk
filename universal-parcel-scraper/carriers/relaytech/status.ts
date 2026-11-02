import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The `delivery_status` values Relay's tracking app knows, which are also each
 * scan's `status`. A code the app does not know falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['order_created', 'registered'], // The shipper has told Relay about the parcel.
  ['awaiting_parcel_drop_off', 'registered'], // The seller has still to drop the parcel off at a shop.
  ['processed_at_gateway', 'in_transit'], // On its way to Relay's warehouse, as the page puts it.
  ['entered_relay_network', 'in_transit'], // Also on its way to Relay's warehouse.
  ['received_at_pitstop', 'accepted'], // The seller dropped the parcel off at a Relay shop.
  ['driver_collected_parcel_from_pitstop', 'in_transit'], // A courier took it from that shop.
  ['received_from_shipper', 'in_transit'], // At Relay's sorting warehouse.
  ['scheduled', 'in_transit'], // Given a delivery route.
  ['preparing_customer_collection', 'in_transit'], // Collection chosen; on its way to the shop.
  ['out_for_delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['awaiting_customer_collection', 'ready_for_pickup'], // Waiting at the shop.
  ['collected_by_customer', 'delivered'], // Collected from the shop.
  ['delivery_failed_will_reattempt', 'failed_attempt'],
  ['reattempting_delivery', 'failed_attempt'], // The page shows the failed delivery with a new attempt to come.
  ['manifested_not_received', 'exception'], // Announced by the shipper but never handed over.
  ['cancelled', 'exception'],
  ['lost_in_transit', 'exception'],
  ['discarded', 'exception'],
  ['return_to_sender_pending', 'returned'],
  ['returning_to_sender', 'returned'],
  ['customer_rejected_rts_pending', 'returned'], // Refused by the recipient; the return is to come.
  ['hsc_received_rts_parcel', 'returned'], // The return reached Relay's warehouse.
  ['rts_parcel_dispatched', 'returned'], // Sent back to the sender.
  ['rts_failed', 'exception'], // The return did not reach the sender.
]);

// A delay leaves the parcel where its previous scan put it.
const DELAYS: ReadonlySet<string> = new Set(['delayed', 'customer_collection_delayed']);

/** The stage Relay's statuses give a code. */
export function relaytechMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toLowerCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. A delay has none. */
export function relaytechStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = relaytechMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (DELAYS.has(code.toLowerCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? relaytechMappedStage(code) : undefined),
  gaps: [
    { code: 'delayed', note: 'A delay notice; the parcel is where its previous scan put it.' },
    { code: 'customer_collection_delayed', note: 'A delay before the parcel reaches its collection shop; it is where its previous scan put it.' },
  ],
};
