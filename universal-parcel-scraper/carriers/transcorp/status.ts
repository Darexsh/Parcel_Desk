import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The labels Elite's tracker shows for its event types. A type the tracker
 * does not label is shown as its code in words.
 */
const LABELS: Readonly<Record<string, string>> = {
  ABANDONED: 'Abandoned',
  ARRIVED_AT_CONSIGNEE_PREMISES: 'Arrived At Consignee Premises',
  ARRIVED_AT_CUSTOMS_CLEARANCE_FACILITY: 'Arrived At Customs Clearance Facility',
  ARRIVED_AT_FACILITY: 'Arrived At Facility',
  ARRIVED_AT_SHIPPER_PREMISES: 'Arrived At Shipper Premises',
  ASSEMBLY_CANCELED: 'Assembly Canceled',
  ASSEMBLY_REQUESTED: 'Assembly Requested',
  AWAITING_ASSEMBLY: 'Awaiting Assembly',
  AWAITING_CONSIGNEE_COLLECTION: 'Awaiting Consignee Collection',
  CANCELED: 'Canceled',
  CONSIGNEE_ADDRESS_INVALID: 'Consignee Address Invalid',
  CONSIGNEE_ADDRESS_UPDATED: 'Consignee Address Updated',
  CONSIGNEE_CONTACT_INVALID: 'Consignee Contact Invalid',
  CONSIGNEE_CONTACT_UPDATED: 'Consignee Contact Updated',
  CONSIGNEE_OFFLOADING_COMPLETED: 'Consignee Offloading Completed',
  CONSIGNEE_UNAVAILABLE: 'Consignee Unavailable',
  CONSIGNEE_UNREACHABLE: 'Consignee Unreachable',
  CONSOLIDATED: 'Consolidated',
  COURIER_ASSIGNED: 'Courier Assigned',
  CUSTOMS_CLEARANCE_COMPLETED: 'Customs Clearance Completed',
  CUSTOMS_CLEARANCE_IN_PROGRESS: 'Customs Clearance In Progress',
  CUSTOMS_CLEARANCE_STATUS_UPDATED: 'Customs Clearance Status Updated',
  DAMAGED: 'Damaged',
  DELAYED: 'Delayed',
  DELIVERED: 'Delivered',
  DELIVERY_ATTEMPTED: 'Delivery Attempted',
  DELIVERY_RESCHEDULE_REQUESTED: 'Delivery Reschedule Requested',
  DELIVERY_SCHEDULED: 'Delivery Scheduled',
  DEPARTED_CUSTOMS_CLEARANCE_FACILITY: 'Departed Customs Clearance Facility',
  DEPARTED_FACILITY: 'Departed Facility',
  DEPARTED_SHIPPER_PREMISES: 'Departed Shipper Premises',
  EN_ROUTE_TO_DELIVERY_LOCATION: 'En Route To Delivery Location',
  EN_ROUTE_TO_RETURN_PICKUP_LOCATION: 'En Route To Return Pickup Location',
  FORWARDED_TO_NEXT_COURIER: 'Forwarded To Next Courier',
  FORWARDED_TO_NEXT_FACILITY: 'Forwarded To Next Facility',
  FORWARDED_TO_THIRD_PARTY_AGENT: 'Forwarded To Third Party Agent',
  IN_TRANSIT: 'In Transit',
  LOST: 'Lost',
  NOTIFICATION_SENT: 'Notification Sent',
  ON_HOLD: 'On Hold',
  OUT_FOR_DELIVERY: 'Out For Delivery',
  OUT_FOR_PICKUP: 'Out For Pickup',
  OUT_FOR_RETURN_DELIVERY: 'Out For Return Delivery',
  PARTIAL_RETURN_DELIVERED: 'Partial Return Delivered',
  PARTIALLY_DELIVERED: 'Partially Delivered',
  PAYMENT_FAILED: 'Payment Failed',
  PAYMENT_RECEIVED: 'Payment Received',
  PICKED_UP: 'Picked Up',
  PICKED_UP_BY_CUSTOMS: 'Picked Up By Customs',
  PICKUP_ATTEMPTED: 'Pickup Attempted',
  PICKUP_CANCELED: 'Pickup Canceled',
  PICKUP_RESCHEDULE_REQUESTED: 'Pickup Reschedule Requested',
  PICKUP_SCHEDULED: 'Pickup Scheduled',
  PROCESSED_AT_FACILITY: 'Processed At Facility',
  PROCESSING_AT_FACILITY: 'Processing At Facility',
  RELEASED_BY_CUSTOMS: 'Released By Customs',
  RETURN_DELIVERED: 'Return Delivered',
  RETURN_DELIVERY_SCHEDULED: 'Return Delivery Scheduled',
  RETURN_INITIATED: 'Return Initiated',
  RETURN_PICKED_UP: 'Return Picked Up',
  RETURN_REQUESTED: 'Return Requested',
  RETURNED_TO_FACILITY: 'Returned To Facility',
  SHIPPER_ADDRESS_INVALID: 'Shipper Address Invalid',
  SHIPPER_LOADING_COMPLETED: 'Shipper Loading Completed',
  SHIPPER_NOTIFIED: 'Shipper Notified',
};

/**
 * Elite's event types by stage. A type outside this map and the gaps falls to
 * the wording rules on its label.
 */
const TYPES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['PICKUP_SCHEDULED', 'registered'],
  ['OUT_FOR_PICKUP', 'registered'],
  ['ARRIVED_AT_SHIPPER_PREMISES', 'registered'],
  ['PICKUP_ATTEMPTED', 'registered'], // The parcel is still with the shipper.
  ['PICKUP_RESCHEDULE_REQUESTED', 'registered'],
  ['SHIPPER_LOADING_COMPLETED', 'accepted'],
  ['DEPARTED_SHIPPER_PREMISES', 'accepted'], // The tracker counts it as the pickup.
  ['ARRIVED_AT_FACILITY', 'in_transit'],
  ['PROCESSING_AT_FACILITY', 'in_transit'],
  ['PROCESSED_AT_FACILITY', 'in_transit'],
  ['DEPARTED_FACILITY', 'in_transit'],
  ['FORWARDED_TO_NEXT_FACILITY', 'in_transit'],
  ['FORWARDED_TO_NEXT_COURIER', 'in_transit'],
  ['FORWARDED_TO_THIRD_PARTY_AGENT', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['ARRIVED_AT_CUSTOMS_CLEARANCE_FACILITY', 'customs'],
  ['CUSTOMS_CLEARANCE_IN_PROGRESS', 'customs'],
  ['CUSTOMS_CLEARANCE_STATUS_UPDATED', 'customs'],
  ['PICKED_UP_BY_CUSTOMS', 'customs'],
  ['CUSTOMS_CLEARANCE_COMPLETED', 'in_transit'], // Cleared: the parcel moves on.
  ['RELEASED_BY_CUSTOMS', 'in_transit'],
  ['DEPARTED_CUSTOMS_CLEARANCE_FACILITY', 'in_transit'],
  ['DELIVERY_SCHEDULED', 'in_transit'],
  ['RETURNED_TO_FACILITY', 'in_transit'], // Back at the hub after a delivery run that did not deliver.
  ['PARTIALLY_DELIVERED', 'in_transit'], // Some pieces delivered; the tracker keeps the shipment in transit.
  ['EN_ROUTE_TO_DELIVERY_LOCATION', 'out_for_delivery'],
  ['OUT_FOR_DELIVERY', 'out_for_delivery'],
  ['ARRIVED_AT_CONSIGNEE_PREMISES', 'out_for_delivery'],
  ['AWAITING_CONSIGNEE_COLLECTION', 'ready_for_pickup'],
  ['DELIVERED', 'delivered'],
  ['DELIVERY_ATTEMPTED', 'failed_attempt'],
  ['CONSIGNEE_UNAVAILABLE', 'failed_attempt'],
  ['CONSIGNEE_UNREACHABLE', 'failed_attempt'],
  ['CONSIGNEE_ADDRESS_INVALID', 'failed_attempt'],
  ['CONSIGNEE_CONTACT_INVALID', 'failed_attempt'],
  ['DELIVERY_RESCHEDULE_REQUESTED', 'failed_attempt'],
  ['RETURN_REQUESTED', 'returned'],
  ['RETURN_INITIATED', 'returned'],
  ['EN_ROUTE_TO_RETURN_PICKUP_LOCATION', 'returned'],
  ['RETURN_PICKED_UP', 'returned'],
  ['RETURN_DELIVERY_SCHEDULED', 'returned'],
  ['OUT_FOR_RETURN_DELIVERY', 'returned'],
  ['PARTIAL_RETURN_DELIVERED', 'returned'],
  ['RETURN_DELIVERED', 'returned'], // The return reached the shipper.
  ['ON_HOLD', 'exception'],
  ['DELAYED', 'exception'],
  ['DAMAGED', 'exception'],
  ['LOST', 'exception'],
  ['ABANDONED', 'exception'],
  ['SHIPPER_ADDRESS_INVALID', 'exception'],
  ['PICKUP_CANCELED', 'exception'],
  ['CANCELED', 'exception'],
]);

/** A courier collected the parcel: its first acceptance, or a later leg. */
export const PICKED_UP = 'PICKED_UP';

const GAPS: readonly { code: string; note: string }[] = [
  { code: 'COURIER_ASSIGNED', note: 'A courier was assigned, for a pickup or a delivery; the parcel does not move.' },
  { code: 'CONSIGNEE_ADDRESS_UPDATED', note: 'The delivery address changed; the parcel does not move.' },
  { code: 'CONSIGNEE_CONTACT_UPDATED', note: 'The consignee\'s contact changed; the parcel does not move.' },
  { code: 'CONSIGNEE_OFFLOADING_COMPLETED', note: 'Unloading at the consignee, which the tracker shows on its own; the delivery is a later event.' },
  { code: 'CONSOLIDATED', note: 'Grouped with other shipments; the tracker treats it as internal.' },
  { code: 'NOTIFICATION_SENT', note: 'A message was sent; the tracker treats it as internal.' },
  { code: 'SHIPPER_NOTIFIED', note: 'The shipper was told about the shipment; the tracker treats it as internal.' },
  { code: 'PAYMENT_RECEIVED', note: 'A payment was recorded; the tracker treats it as internal.' },
  { code: 'PAYMENT_FAILED', note: 'A payment failed; the tracker treats it as internal.' },
  { code: 'ASSEMBLY_REQUESTED', note: 'Assembly service at the consignee; it says nothing about the parcel\'s journey.' },
  { code: 'AWAITING_ASSEMBLY', note: 'Assembly service at the consignee; it says nothing about the parcel\'s journey.' },
  { code: 'ASSEMBLY_CANCELED', note: 'Assembly service at the consignee; it says nothing about the parcel\'s journey.' },
];
const GAP_CODES = new Set(GAPS.map((gap) => gap.code));

/** The label the tracker shows for an event type. */
export function transcorpLabel(code: string): string {
  return LABELS[code] ?? code.toLowerCase().split('_').filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

/** The stage an event type gives on its own. */
export function transcorpMappedStage(code: string): Stage | undefined {
  return TYPES.get(code.toUpperCase());
}

/**
 * An event's stage. A pickup accepts the parcel when nothing moved it before;
 * after customs or another leg, a courier picking it up moves it on.
 */
export function transcorpStage(code: string, moved: boolean): ClassifiedWording | null {
  if (code === PICKED_UP) return { stage: moved ? 'in_transit' : 'accepted', source: 'carrier_map' };
  const mapped = transcorpMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAP_CODES.has(code)) return null;
  const worded = classifyWording(transcorpLabel(code), 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// A pickup depends on the events before it, so its code alone gives no stage.
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? transcorpMappedStage(code) : undefined),
  gaps: GAPS,
};
