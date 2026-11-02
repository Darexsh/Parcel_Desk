import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of MeaSoft, the courier software Exline's tracker reads.
 * MeaSoft's API documentation lists them; each scan carries one, with its
 * Russian title. Another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['AWAITING_SYNC', 'registered'], // The order is not in the courier's own system yet.
  ['NEW', 'registered'], // Created and sent to the courier.
  ['NEWPICKUP', 'registered'], // A collection was booked.
  ['PICKUP', 'accepted'], // Collected from the sender.
  // Received at a warehouse: the sending branch's or, after a transfer, the receiving one's.
  ['ACCEPTED', 'in_transit'],
  ['PICKUPTRANS', 'in_transit'], // Collected from the line-haul carrier that brought it between cities.
  ['DEPARTURING', 'in_transit'], // A transfer to another branch is planned.
  ['DEPARTURE', 'in_transit'], // Sent to another branch.
  ['CUSTOMSPROCESS', 'customs'],
  ['CUSTOMSFINISHED', 'in_transit'], // Cleared by customs.
  ['CONFIRM', 'in_transit'], // A delivery time was agreed with the recipient.
  ['PICKUPREADY', 'ready_for_pickup'],
  ['DELIVERY', 'out_for_delivery'], // Handed to a courier for delivery.
  ['COURIERDELIVERED', 'delivered'], // Delivered, as the courier reports it before a manager confirms it.
  ['COURIERPARTIALLY', 'delivered'], // Partly delivered, as the courier reports it: the recipient kept part of the order.
  ['COURIERCANCELED', 'failed_attempt'], // Refused, as the courier reports it.
  // The courier brought it back undelivered; it goes out again or back to the sender.
  ['COURIERRETURN', 'failed_attempt'],
  ['COMPLETE', 'delivered'],
  ['PARTIALLY', 'delivered'], // Partly delivered: the recipient kept part of the order.
  ['CANCELED', 'exception'], // Not delivered: cancelled, or to go back to the sender.
  ['RETURNING', 'returned'], // On its way back to the sender.
  ['RETURNED', 'returned'],
  ['LOST', 'exception'],
]);

/** The stage MeaSoft's codes give a status code. */
export function exlineMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

const GAPS = [
  { code: 'WMSASSEMBLED', note: 'The order was picked at a fulfilment centre before its handover; it moves nothing.' },
  { code: 'WMSDISASSEMBLED', note: 'A fulfilment centre undid an order\'s picking; it moves nothing.' },
  { code: 'INVENTORY', note: 'A stock check that found the parcel where it was; it moves nothing.' },
  { code: 'UNCONFIRM', note: 'A call that did not settle a delivery time; the parcel stays where it was.' },
  { code: 'DATECHANGE', note: 'A new delivery date; it moves nothing.' },
] as const;
const GAP_CODES = new Set<string>(GAPS.map((gap) => gap.code));

/** A status's stage: its code, else the shared wording rules, else nothing. */
export function exlineStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = exlineMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAP_CODES.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? exlineMappedStage(code) : undefined),
  gaps: GAPS,
};
