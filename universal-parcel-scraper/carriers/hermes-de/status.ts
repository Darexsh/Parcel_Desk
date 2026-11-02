/**
 * Hermes Germany status classification.
 *
 * The public recipient service labels every history row with a stable
 * `parcelStatus` enum, so this carrier is mapped by code alone: no wording
 * rules, no language guessing. `description` is the fallback text used when the
 * row carries no `historyText` of its own.
 *
 * A code that is not in this map is deliberately left unclassified. Its scan
 * goes to the shared wording classifier, the adapter reports a shipment whose
 * latest scan it is as `unknown` rather than inventing a stage, and the sync
 * records the wording for review.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import type { Stage } from '../../generated/catalog.js';

export interface Milestone {
  stage: Stage;
  status: CarrierStatus;
  description: string;
}

function milestone(stage: Stage, status: CarrierStatus, description: string): Milestone {
  return { stage, status, description };
}

/** `parcelStatus` → milestone, read from the public recipient bundle on 2026-09-08. */
export const STATUSES: Record<string, Milestone> = {
  ANNOUNCED: milestone('registered', 'pending', 'Shipment announced to Hermes'),
  ORDER_INFO_RECEIVED: milestone('registered', 'pending', 'Shipment announced to Hermes'),
  PREANNOUNCED: milestone('registered', 'pending', 'Shipment announced to Hermes'),
  ATG_OUT_OF_WAREHOUSE: milestone('registered', 'pending', 'Sender preparing handover to Hermes'),
  // The sender's drop-off at a ParcelShop, which takes the parcel in for Hermes.
  PARCELSHOP_DROP_OFF: milestone('accepted', 'in_transit', 'Dropped off at a ParcelShop'),
  HANDED_OVER: milestone('accepted', 'in_transit', 'Shipment handed to Hermes'),
  HANDED_OVER_TO_HERMES: milestone('accepted', 'in_transit', 'Shipment handed to Hermes'),
  TAKEN_OVER_BY_HERMES: milestone('accepted', 'in_transit', 'Shipment collected by Hermes'),
  PICKED_UP: milestone('accepted', 'in_transit', 'Shipment collected by Hermes'),
  SHIPMENT_PICKED_UP: milestone('accepted', 'in_transit', 'Shipment collected by Hermes'),
  PARCELSHOP_COLLECTED_BY_DRIVER: milestone('accepted', 'in_transit', 'Shipment collected by Hermes'),
  ARRIVED_IN_DESTINATION_REGION: milestone('in_transit', 'in_transit', 'Shipment arrived in the destination region'),
  ARRIVED_AT_DEPOT: milestone('in_transit', 'in_transit', 'Shipment arrived at the depot'),
  ARRIVED_AT_DELIVERY_DEPOT: milestone('in_transit', 'in_transit', 'Shipment arrived at the delivery depot'),
  ARRIVED_IN_DESTINATION_REGION_V2: milestone('in_transit', 'in_transit', 'Shipment arrived in the destination region'),
  IN_TRANSIT: milestone('in_transit', 'in_transit', 'Shipment in transit'),
  SORTED: milestone('in_transit', 'in_transit', 'Shipment sorted at the hub'),
  INTERNATIONAL_ARRIVED_IN_COUNTRY: milestone('in_transit', 'in_transit', 'Shipment arrived in the destination country'),
  INTERNATIONAL_SORTED: milestone('in_transit', 'in_transit', 'Shipment sorted in the destination country'),
  DELIVERY_TOUR_STARTED: milestone('out_for_delivery', 'out_for_delivery', 'Out for delivery'),
  OUT_FOR_DELIVERY: milestone('out_for_delivery', 'out_for_delivery', 'Out for delivery'),
  NEXT_STOP: milestone('out_for_delivery', 'out_for_delivery', 'Courier is at the next stop'),
  INTERNATIONAL_DELIVERY_TOUR_STARTED: milestone('out_for_delivery', 'out_for_delivery', 'Out for delivery'),
  DELIVERED: milestone('delivered', 'delivered', 'Delivered'),
  DELIVERED_HOMEDELIVERY: milestone('delivered', 'delivered', 'Delivered'),
  DELIVERED_INHOUSE: milestone('delivered', 'delivered', 'Delivered at the address'),
  DELIVERED_NEIGHBOUR: milestone('delivered', 'delivered', 'Delivered to a neighbour'),
  DELIVERED_DROPOFF: milestone('delivered', 'delivered', 'Delivered to the agreed safe place'),
  DELIVERED_MAILBOX: milestone('delivered', 'delivered', 'Delivered to the mailbox'),
  DELIVERED_PARCELSHOP: milestone('delivered', 'delivered', 'Collected at the ParcelShop'),
  PICKED_UP_BY_RECIPIENT: milestone('delivered', 'delivered', 'Collected by the recipient'),
  COLLECTED: milestone('delivered', 'delivered', 'Collected by the recipient'),
  PARCELSHOP_COLLECTED_BY_CUSTOMER: milestone('delivered', 'delivered', 'Collected at the ParcelShop'),
  INTERNATIONAL_DELIVERED: milestone('delivered', 'delivered', 'Delivered'),
  // A Hermes Box is a pickup locker: the recipient takes the parcel out with
  // a pickup code within 72 hours, or it goes back to the sender.
  DELIVERED_PARCELBOX: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection from the Hermes Box'),
  READY_FOR_PICKUP: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection'),
  PARCELSHOP_ITEMS_FOR_COLLECTION: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection at the ParcelShop'),
  READY_FOR_COLLECTION: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection'),
  PARCELSHOP_READY_FOR_COLLECTION: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection at the ParcelShop'),
  DELIVERY_FAILED: milestone('failed_attempt', 'exception', 'Delivery attempt unsuccessful'),
  DELIVERY_FAILED_ADDRESS_PROBLEM: milestone('failed_attempt', 'exception', 'Delivery address not found'),
  DELIVERY_FAILED_NOT_MET_1X: milestone('failed_attempt', 'exception', 'Recipient not met; another attempt follows'),
  INTERNATIONAL_DELIVERY_FAILED: milestone('failed_attempt', 'exception', 'Delivery attempt unsuccessful'),
  INTERNATIONAL_DELIVERY_FAILED_ADDRESS: milestone('failed_attempt', 'exception', 'Delivery address not found'),
  INTERNATIONAL_PUDO_READY_FOR_COLLECTION: milestone('ready_for_pickup', 'out_for_delivery', 'Ready for collection at a parcel shop'),
  INTERNATIONAL_PUDO_NOT_COLLECTED: milestone('exception', 'exception', 'Not collected from the parcel shop'),
  INTERNATIONAL_UNDELIVERABLE: milestone('exception', 'exception', 'Shipment not deliverable'),
  NOT_DELIVERABLE: milestone('exception', 'exception', 'Shipment not deliverable'),
  UNKNOWN_WHEREABOUTS: milestone('exception', 'exception', 'Shipment whereabouts unknown'),
  RETURN_TO_SENDER: milestone('returned', 'exception', 'Returning to sender'),
  RETURN_DELIVERED_TO_SENDER: milestone('returned', 'exception', 'Returned to sender'),
  RETURN: milestone('returned', 'exception', 'Returning to sender'),
  RETOURE_DELIVERED: milestone('returned', 'exception', 'Returned to sender'),
};

// Delivery preference bookings (a safe place, a ParcelShop) record the
// recipient's wish, not a movement, and must never move the parcel backwards.
export const IGNORED_BOOKING_STATUS = new Set(['EDL_BOOKED_DROPOFF', 'EDL_BOOKED_PARCELSHOP']);

/**
 * A parcel abroad its recipient did not collect from the parcel shop goes back: a later
 * `INTERNATIONAL_DELIVERED` is its hand-over on the way to the sender, not a delivery.
 */
export const NOT_COLLECTED_ABROAD = 'INTERNATIONAL_PUDO_NOT_COLLECTED';
export const DELIVERED_ABROAD = 'INTERNATIONAL_DELIVERED';
export const RETURN_HANDOVER = milestone('returned', 'exception', 'Returning to sender');

/** The code for a parcel put into a Hermes Box, which waits there for its recipient. */
export const IN_PARCELBOX = 'DELIVERED_PARCELBOX';

/** Codes for a parcel the recipient collected at a ParcelShop. */
export const COLLECTED_AT_PARCELSHOP = new Set(['PARCELSHOP_COLLECTED_BY_CUSTOMER', 'DELIVERED_PARCELSHOP']);

/** The milestone for a `parcelStatus`, or undefined when the code is not mapped. */
export function hermesGermanyMilestone(parcelStatus: string): Milestone | undefined {
  return Object.hasOwn(STATUSES, parcelStatus) ? STATUSES[parcelStatus] : undefined;
}

/** What the map says about one row by its `parcelStatus`, the provider code every row carries. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? hermesGermanyMilestone(code)?.stage : undefined),
  gaps: [...IGNORED_BOOKING_STATUS].map((code) => ({
    code,
    note: "The recipient's delivery preference, not a movement: the adapter drops the row so it cannot move the parcel backwards.",
  })),
};
