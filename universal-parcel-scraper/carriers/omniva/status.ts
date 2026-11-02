import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Omniva names each scan with an event code from its trackers' dictionary and
// words it in English. TRT codes are its own network's, with the UPU EDI
// events of a cross-border item under their UPU letters; CARGO codes come from
// its freight partners.
const EVENTS: Readonly<Record<string, Stage>> = {
  TRT_SHIPMENT_REGISTERED: 'registered',
  TRT_SHIPMENT_REGISTERED_IN_OMNIVA: 'registered',
  TRT_SHIPMENT_HANDOVER_TO_PM: 'accepted',
  TRT_SHIPMENT_HANDOVER_TO_PO: 'accepted',
  TRT_SHIPMENT_PICKED_UP_BY_COURIER: 'accepted',
  TRT_SHIPMENT_EMA: 'accepted',
  TRT_SHIPMENT_DEPARTED_FROM_PM: 'in_transit',
  TRT_SHIPMENT_ARRIVED_TO_PO: 'in_transit',
  TRT_SHIPMENT_SORTED: 'in_transit',
  TRT_SHIPMENT_REDIRECTION: 'in_transit',
  TRT_SHIPMENT_MOVEMENT_RESTORED: 'in_transit',
  // The return is called off and the item goes on to its recipient.
  TRT_SHIPMENT_RETURN_CANCELLED: 'in_transit',
  TRT_SHIPMENT_RELEASED_FROM_CUSTOMS: 'in_transit',
  TRT_SHIPMENT_EMB: 'in_transit',
  TRT_SHIPMENT_EMC: 'in_transit',
  TRT_SHIPMENT_EMD: 'in_transit',
  TRT_SHIPMENT_EMF: 'in_transit',
  TRT_SHIPMENT_EMG: 'in_transit',
  TRT_SHIPMENT_EMJ: 'in_transit',
  TRT_SHIPMENT_EDC: 'in_transit',
  TRT_SHIPMENT_EDD: 'in_transit',
  TRT_SHIPMENT_EDE: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_TRANSIT_HUB: 'in_transit',
  CARGO_SHIPMENT_DEPARTED_FROM_TRANSIT_HUB: 'in_transit',
  CARGO_SHIPMENT_IN_TRANSIT_TO_DESTINATION_COUNTRY: 'in_transit',
  CARGO_SHIPMENT_ARRIVING_TO_DESTINATION_COUNTRY: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_DESTINATION_COUNTRY: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_CUSTOMS_CLEARANCE_HUB: 'in_transit',
  CARGO_SHIPMENT_RELEASED_FROM_CUSTOMS: 'in_transit',
  CARGO_SHIPMENT_HANDOVER_FROM_LINEHAUL_EVENT: 'in_transit',
  CARGO_SHIPMENT_HANDED_TO_LAST_MILE: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_SORTING: 'in_transit',
  CARGO_SHIPMENT_DEPARTED_FROM_SORTING: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_LAST_DELIVERY_OFFICE: 'in_transit',
  CARGO_SHIPMENT_DEPARTED_FROM_RETURNING_COUNTRY: 'in_transit',
  CARGO_SHIPMENT_ARRIVED_TO_RETURNING_COUNTRY_HUB: 'in_transit',
  TRT_SHIPMENT_TAKEN_TO_CUSTOMS: 'customs',
  TRT_SHIPMENT_HELD_IN_CUSTOMS: 'customs',
  TRT_SHIPMENT_ASSIGN_CUSTOMS_INSPECTION: 'customs',
  // An item from outside the EU waits at customs for its recipient's
  // declaration or payment; these notices ask for them.
  TRT_SHIPMENT_ARRIVAL_CUSTOMS_NOTIFICATION: 'customs',
  TRT_SHIPMENT_CD_REMINDER_NOTIFICATION: 'customs',
  TRT_SHIPMENT_CD_ADD_PAYMENT_NOTIFICATION: 'customs',
  TRT_SHIPMENT_CD_ADD_PAYMENT_REMINDER_NOTIFICATION: 'customs',
  TRT_SHIPMENT_CUSTOMS_PAYMENT_REQ_REMINDER: 'customs',
  TRT_SHIPMENT_EDB: 'customs',
  TRT_SHIPMENT_EME: 'customs',
  CARGO_SHIPMENT_PRESENTED_TO_CUSTOMS: 'customs',
  CARGO_SHIPMENT_HELD_IN_CUSTOMS: 'customs',
  TRT_SHIPMENT_COURIER_DELIVERY_STARTED: 'out_for_delivery',
  TRT_SHIPMENT_EDG: 'out_for_delivery',
  CARGO_SHIPMENT_OUT_FOR_DELIVERY: 'out_for_delivery',
  TRT_SHIPMENT_FAILED_DELIVERY_ATTEMPT: 'failed_attempt',
  TRT_SHIPMENT_EMH: 'failed_attempt',
  CARGO_SHIPMENT_DELIVERY_FAILED: 'failed_attempt',
  TRT_SHIPMENT_STORED_IN_PM: 'ready_for_pickup',
  TRT_SHIPMENT_ARRIVED_TO_FINAL_PO: 'ready_for_pickup',
  TRT_SHIPMENT_EDH: 'ready_for_pickup',
  TRT_SHIPMENT_DELIVERED: 'delivered',
  TRT_SHIPMENT_EMI: 'delivered',
  CARGO_SHIPMENT_DELIVERED: 'delivered',
  CARGO_SHIPMENT_RETURNED: 'returned',
  // A return under way: the item is not delivered and not back yet.
  TRT_SHIPMENT_RETURN: 'exception',
  CARGO_SHIPMENT_POSTED_IN_RETURNING_COUNTRY: 'exception',
  TRT_SHIPMENT_CANCELLED: 'exception',
  TRT_SHIPMENT_MOVEMENT_STOPPED: 'exception',
  TRT_SHIPMENT_MISSING_IN_PM: 'exception',
  TRT_SHIPMENT_PREDECLARED_MISSING: 'exception',
  TRT_SHIPMENT_PROHIBIT: 'exception',
  TRT_SHIPMENT_EDX: 'exception',
  TRT_SHIPMENT_EXX: 'exception',
  CARGO_SHIPMENT_CANCELLED: 'exception',
  CARGO_SHIPMENT_DESTROYED: 'exception',
  CARGO_SHIPMENT_MISSING_IN_PM: 'exception',
  CARGO_SHIPMENT_NOT_ARRIVED_IN_BAG_EVENT: 'exception',
};

/** Scans that start a return: a delivery after one reaches the sender. */
export const RETURN_STARTS: ReadonlySet<string> = new Set(['TRT_SHIPMENT_RETURN', 'CARGO_SHIPMENT_POSTED_IN_RETURNING_COUNTRY']);
/** The scan that calls a return off. */
export const RETURN_CANCELLED = 'TRT_SHIPMENT_RETURN_CANCELLED';

// Messages to the recipient and bookkeeping: no movement, so the item keeps its stage.
const NOTICES = new Map<string, string>([
  ['TRT_SHIPMENT_ARRIVAL_PM_NOTIFICATION', 'The recipient is told the item waits in a parcel machine.'],
  ['TRT_SHIPMENT_ARRIVAL_PO_NOTIFICATION', 'The recipient is told the item waits at a post office.'],
  ['TRT_SHIPMENT_REMINDER_PM_NOTIFICATION', 'A reminder that the item waits in a parcel machine.'],
  ['TRT_SHIPMENT_REMINDER_PO_NOTIFICATION', 'A reminder that the item waits at a post office.'],
  ['TRT_SHIPMENT_RECIPIENT_NOTIFICATION_EVENT', 'A message to the recipient.'],
  ['TRT_COURIER_PRE_DELIVERY_RECIPIENT_NOTIFICATION', 'The recipient is told the courier is coming.'],
  ['TRT_COURIER_CALLED_TO_RECEIVER', 'The courier contacted the recipient about the delivery.'],
  ['TRT_SHIPMENT_RECIPIENT_CONTACT_UPDATED', 'The recipient\'s contact details changed.'],
  ['TRT_SHIPMENT_DELIVERY_PARTNER_BARCODE_ASSIGNED', 'A delivery partner\'s number was attached to the item.'],
  ['CARGO_SHIPMENT_DELIVERY_PARTNER_BARCODE_ASSIGNED', 'A delivery partner\'s number was attached to the item.'],
  ['TRT_SHIPMENT_MEASURED', 'The item was measured.'],
]);

// Codes whose meaning for the delivery is unclear, left without a stage.
const UNSTAGED = new Map<string, string>([
  ['TRT_SHIPMENT_EDA', 'Held at the inward office of exchange, for customs or for another reason the event does not give.'],
  ['TRT_SHIPMENT_EDF', 'Held at the delivery depot, for a reason the event does not give.'],
  ['TRT_SHIPMENT_DOC_RETURN_SENDER', 'A document about the item went back to the sender, not the item itself.'],
  ['TRT_SHIPMENT_RETURNED_BY_CUSTOMER', 'A customer return sent through Omniva; no reply showed where it stands in the delivery.'],
  ['TRT_SHIPMENT_COURIER_DELIVERY_CANCELLED', 'The courier round was called off; the event does not say what happens next.'],
  ['TRT_SHIPMENT_DECLARATION_CANCELLED', 'A customs declaration was withdrawn; the item may still be held or move on.'],
  ['CARGO_SHIPMENT_DELIVERED_TO_RETURNS_CENTER', 'Reached a returns centre, which may end a customer return or start one to the sender.'],
  ['CARGO_SHIPMENT_WAITING_FOR_PAYMENT', 'Waits for a payment the event does not name, such as duties or a delivery charge.'],
  ['CARGO_SHIPMENT_ARRIVED_TO_LAST_PICKUP_POINT', 'Either waiting for the recipient or reaching the last hub before delivery; no reply showed which.'],
]);

/**
 * The item's state, which Omniva's trackers show as the headline. The trackers
 * know seven; the dictionary lists the older ones too.
 */
const STATES = new Map<string, { wording: string; stage: Stage }>([
  ['REGISTERED', { wording: 'Registered', stage: 'registered' }],
  ['REGISTERED_IN_OMNIVA', { wording: 'Shipment registered', stage: 'registered' }],
  ['IPS_POSTED_EMA', { wording: 'Item is posted by the sender/collected by the Post', stage: 'accepted' }],
  ['IN_PROGRESS', { wording: 'In progress', stage: 'in_transit' }],
  ['IN_TRANSIT', { wording: 'Shipment is on the way', stage: 'in_transit' }],
  ['IN_POST_OFFICE', { wording: 'Shipment is at the postal facility', stage: 'in_transit' }],
  ['IN_LOGISTIC_CENTER', { wording: 'Shipment is at the sorting centre', stage: 'in_transit' }],
  ['IPS_DEPARTED_EMC', { wording: 'Departure from sender country', stage: 'in_transit' }],
  ['IPS_ARRIVED_EMD', { wording: 'Arrived to destination country', stage: 'in_transit' }],
  ['RELEASED_FROM_CUSTOMS', { wording: 'Released from customs', stage: 'in_transit' }],
  ['MOVEMENT_RESTORED', { wording: 'Movement restored', stage: 'in_transit' }],
  ['RETURN_CANCELLED', { wording: 'Return cancelled', stage: 'in_transit' }],
  ['REDIRECTED', { wording: 'Redirected', stage: 'in_transit' }],
  ['IN_CUSTOMS', { wording: 'In customs', stage: 'customs' }],
  ['TAKEN_TO_CUSTOMS', { wording: 'In customs', stage: 'customs' }],
  ['ON_COURIER_DELIVERY', { wording: 'On your way', stage: 'out_for_delivery' }],
  ['FAILED_DELIVERY', { wording: 'Failed delivery attempt', stage: 'failed_attempt' }],
  ['READY_FOR_PICKUP', { wording: 'Ready for pickup', stage: 'ready_for_pickup' }],
  ['IN_PARCEL_MACHINE', { wording: 'Shipment delivered to the parcel machine', stage: 'ready_for_pickup' }],
  ['DELIVERED', { wording: 'Delivered', stage: 'delivered' }],
  ['RETURNED', { wording: 'Returned', stage: 'returned' }],
  ['CANCELLED', { wording: 'Cancelled', stage: 'exception' }],
  ['WRITTEN_OFF', { wording: 'Shipment written off', stage: 'exception' }],
  ['STOPPED', { wording: 'Shipment stopped', stage: 'exception' }],
  ['MISSING', { wording: 'Shipment missing', stage: 'exception' }],
  ['LOST', { wording: 'Shipment missing', stage: 'exception' }],
]);

export function omnivaEventStage(code: string): Stage | undefined {
  return Object.hasOwn(EVENTS, code) ? EVENTS[code] : undefined;
}

export function isOmnivaNotice(code: string): boolean {
  return NOTICES.has(code);
}

/** The English wording and stage of an item's state, if the map knows it. */
export function omnivaState(code: string): { wording: string; stage: Stage } | undefined {
  return STATES.get(code);
}

/** Event codes and state codes do not overlap: events carry a TRT or CARGO prefix. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? omnivaEventStage(code) ?? omnivaState(code)?.stage : undefined),
  gaps: [
    ...[...NOTICES].map(([code, note]) => ({ code, note: `${note} Not a movement: the item keeps the stage it had.` })),
    ...[...UNSTAGED].map(([code, note]) => ({ code, note })),
  ],
};
