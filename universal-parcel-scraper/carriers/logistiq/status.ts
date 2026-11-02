import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Logistiq's status codes. Forward shipments and customer returns have codes
 * of their own, so a code means the same thing whatever the shipment. The
 * names and meanings are those of Logistiq's webhook documentation; the
 * tracker gives the same code and name with each scan. Another code falls to
 * the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['101', 'registered'], // BOOKED: the order is in the system.
  ['154', 'registered'], // OUT_FOR_PICKUP: a driver is on the way to the sender.
  ['105', 'accepted'], // PICKED_UP, as the documentation numbers it.
  ['109', 'accepted'], // PICKED_UP, as the tracker numbers it for Logistiq's own drivers.
  ['106', 'in_transit'], // IN_HUB
  ['107', 'in_transit'], // MANIFESTED: listed for dispatch.
  ['110', 'in_transit'], // INTRANSIT: between hubs.
  ['182', 'in_transit'], // HANDED_OVER_AT_ORIGIN_PORT
  ['183', 'in_transit'], // DEPARTED_FROM_ORIGIN_PORT
  ['184', 'in_transit'], // ARRIVED_AT_DESTINATION_PORT
  ['185', 'in_transit'], // CLEARED_FROM_DESTINATION_PORT: customs let it go.
  ['186', 'customs'], // HELD_BY_CUSTOMS
  ['187', 'exception'], // CONFISCATED_BY_CUSTOMS
  ['188', 'exception'], // PROHIBITED_BY_CUSTOMS
  ['111', 'out_for_delivery'],
  ['122', 'failed_attempt'], // FAILED_DELIVERY: the parcel goes out again.
  ['112', 'delivered'],
  ['104', 'exception'], // CANCELLED before pickup.
  ['115', 'exception'], // ON_HOLD
  ['116', 'exception'], // LOST
  ['117', 'exception'], // DAMAGED
  ['118', 'exception'], // SHIPMENT_DELAYED
  ['119', 'exception'], // SHIPMENT_HELD over documents or the address.
  ['121', 'exception'], // NOT_SERVICEABLE
  ['190', 'exception'], // AIRLINE_DELAY
  ['191', 'exception'], // LOST_AT_GATEWAY
  ['192', 'exception'], // DAMAGED_AT_GATEWAY
  ['147', 'returned'], // RTO_REQUESTED: on its way back to the sender.
  ['168', 'returned'], // RTO
  ['153', 'returned'], // RTO_INTRANSIT
  ['169', 'returned'], // RTO_SHIPMENT_DELAY
  ['148', 'returned'], // RTO_OUT_FOR_DELIVERY to the sender.
  ['150', 'returned'], // RTO_FAILED
  ['149', 'returned'], // RTO_DELIVERED to the sender.
  ['113', 'returned'], // PARTIALLY_RETURNED
  ['114', 'returned'], // RETURNED
  ['189', 'returned'], // RE-EXPORT_BACK_TO_ORIGIN
  // A customer's return, from the customer to the merchant.
  ['124', 'registered'], // CREATED
  ['158', 'registered'], // AWB_REGISTERED
  ['130', 'registered'], // UNASSIGNED: no driver for the pickup yet.
  ['131', 'registered'], // ASSIGNED
  ['144', 'registered'], // PICKUP_PENDING
  ['125', 'registered'], // OUT_FOR_PICKUP
  ['162', 'registered'], // EXCHANGE_PICKUP: an exchange pickup is booked.
  ['126', 'accepted'], // PICKED_UP
  ['127', 'in_transit'], // INTRANSIT
  ['128', 'in_transit'], // IN_HUB
  ['129', 'in_transit'], // MANIFESTED
  ['164', 'in_transit'], // EXCHANGE_INTRANSIT
  ['140', 'out_for_delivery'],
  ['167', 'failed_attempt'], // FAILED_DELIVERY
  ['132', 'delivered'], // DELIVERED: the return reached the merchant.
  ['166', 'delivered'], // EXCHANGE_DELIVERED
  ['133', 'exception'], // RETURN_CANCELLED
  ['134', 'exception'], // ON HOLD
  ['135', 'exception'], // LOST
  ['136', 'exception'], // DAMAGED
  ['137', 'exception'], // SHIPMENT_DELAYED
  ['138', 'exception'], // SHIPMENT_HELD
  ['152', 'exception'], // CONTACT_CUSTOMER_CARE
  ['156', 'exception'], // RTO_CONACT_CUSTOMER_CARE, spelled so.
  ['160', 'exception'], // EXPIRED
  ['170', 'exception'], // NOT_SERVICEABLE
]);

const GAPS = [
  { code: '139', note: 'PICKUP_FAILED: a driver did not collect a customer\'s return, which has not moved; the pickup is tried again.' },
  { code: '142', note: 'UNMAPPED_RETURN: Logistiq\'s own placeholder for a partner\'s return status it has no name for.' },
] as const;
const UNSTAGED: ReadonlySet<string> = new Set(GAPS.map(({ code }) => code));

/** The stage Logistiq's code gives a scan. */
export function logistiqMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function logistiqStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = logistiqMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? logistiqMappedStage(code) : undefined),
  gaps: GAPS,
};
