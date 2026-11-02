import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The shipment states of Jumppoint's tracker, with the English labels its
 * script shows for them. A state heads the shipment and names each row of its
 * status log.
 */
const STATES: ReadonlyMap<string, readonly [string, Stage]> = new Map([
  ['CREATED', ['Created', 'registered']], // The merchant created the waybill.
  ['SENDER_DROPPED_OFF_AT_PICK_UP_STORE', ['Passed to Pick Up Store', 'accepted']], // The sender left it at a pick-up point.
  ['ARRIVED_AT_DROP_OFF_STORE_WAREHOUSE', ['Arrived at Drop-off Store Warehouse', 'in_transit']],
  ['ON_THE_WAY_TO_WAREHOUSE', ['On the Way To Warehouse', 'accepted']], // Collected, on its way to Jumppoint's warehouse.
  ['ARRIVED_AT_WAREHOUSE', ['Arrived At Warehouse', 'in_transit']],
  ['NOTICED_THIRD_PARTY', ['Noticed Third Party', 'in_transit']], // The Chinese label reads "arrived at the warehouse".
  ['SENDING_TO_ANOTHER_WAREHOUSE', ['Warehouse Transfer', 'in_transit']],
  ['COURIER_ASSIGNED', ['Assigned to Courier', 'in_transit']],
  // The courier took the parcel to deliver it: live, a second before ON_THE_WAY_TO_CUSTOMER,
  // after the warehouse or, for a same-day parcel, after the order was confirmed.
  ['PASSED_TO_COURIER', ['Passed to Courier', 'out_for_delivery']],
  ['ON_THE_WAY_TO_CUSTOMER', ['On the Way To Customer', 'out_for_delivery']],
  ['ON_THE_WAY_TO_PICK_UP_STORE', ['On the Way To Pick Up Store', 'in_transit']],
  ['ON_THE_WAY_TO_THIRD_PARTY', ['On the Way To Pick Up Store', 'in_transit']],
  ['ARRIVED_AT_THIRD_PARTY_WAREHOUSE', ['Arrived At Third Party Warehouse', 'in_transit']], // A pick-up network's own depot.
  ['ARRIVED_AT_PICK_UP_STORE', ['Arrived At Pick Up Store', 'ready_for_pickup']],
  ['ARRIVED_AT_THIRD_PARTY_PICK_UP_STORE', ['Arrived At Circle-K Pick Up Store', 'ready_for_pickup']],
  ['COMPLETED', ['Completed', 'delivered']],
  ['UNDELIVERED', ['Undelivered', 'failed_attempt']],
  ['PROBLEM_ITEM', ['Unsuccessful Delivery', 'failed_attempt']],
  ['PROBLEM_SHIPMENT', ['Unsuccessful Delivery', 'failed_attempt']],
  ['PROBLEM_ITEM_TO_WAREHOUSE', ['Unsuccessful Delivery', 'failed_attempt']],
  ['PICK_UP_STORE_PROBLEM_ITEM', ['Unsuccessful Delivery', 'failed_attempt']],
  ['SCHEDULED_FOR_REDELIVER', ['Scheduled for Redelivery', 'failed_attempt']],
  // A pick-up point sends back a parcel nobody collected.
  ['REQUESTED_RETURN_FROM_THIRD_PARTY', ['Requested Return', 'returned']],
  ['READY_TO_RETURN_FROM_THIRD_PARTY', ['Requested Return', 'returned']],
  ['RETURNING_FROM_THIRD_PARTY', ['Returning', 'returned']],
  ['RETURNING_FROM_THIRD_PARTY_COMPANY_WAREHOUSE', ['Returning Parcel', 'returned']],
  ['RETURNED_TO_MERCHANT', ['Returned to Merchant', 'returned']],
  ['RETURNED_TO_MERCHANT_AT_WAREHOUSE', ['Returned to Merchant at Warehouse', 'returned']],
  ['NOT_ABLE_TO_RECEIVE_PRODUCTS', ['Not Able To Receive Products', 'exception']], // The courier could not collect it.
  ['REJECTED', ['Rejected', 'exception']], // Jumppoint refused the order.
  ['CANCELLED', ['Cancelled', 'exception']],
  ['DELETED', ['Deleted', 'exception']],
  ['VOID', ['Void', 'exception']],
  ['REFUNDED', ['Refunded', 'exception']],
]);

/** States that say nothing about where the parcel is. */
const UNSTAGED: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['CONFIRMED', ['Confirmed', 'Jumppoint confirms the waybill before a same-day courier collects the parcel, and again at its warehouse before delivery; it moves nothing.']],
  ['PROCESSING', ['Processing', 'A shipment under way, named by no step; the tracker also shows it for a state it has no label for.']],
  ['ERROR', ['Error', 'A waybill Jumppoint\'s system could not handle; it names no step.']],
]);

/** The reasons a status log row can carry, as the tracker words them in English. */
const REMARKS: ReadonlyMap<string, string> = new Map([
  ['RECEIVER_CHANGE_DATE', 'Receiver change date'],
  ['CANNOT_FIND_ADDRESS', 'Cannot find address'],
  ['NOBODY_ANSWER_THE_DOOR', 'Nobody answer the door'],
  ['NOT_ENOUGH_TIME', 'Scheduled for Redeliver'],
  ['PARCEL_DAMAGED', 'Parcel damaged'],
  ['PARCEL_LOST', 'Parcel lost'],
  ['OTHER_REASON', 'Other reason'],
  ['SENDER_CHANGE_DATE', 'Sender change date'],
  ['REJECTED_BY_RECEIVER', 'Rejected by receiver'],
  ['PICK_UP_STORE_CLOSED', 'Pick up store closed'],
  ['REJECTED_BY_PICK_UP_STORE', 'Rejected by pick up store'],
  ['OVERDUE', 'Overdue'],
]);

/** The tracker's English label for a state; one it has no label for is spelled out from its code. */
export function jumppointLabel(code: string): string {
  const known = STATES.get(code)?.[0] ?? UNSTAGED.get(code)?.[0];
  if (known) return known;
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tracker's English label for a reason code, or nothing for any other remark. */
export function jumppointRemark(code: string): string | undefined {
  return REMARKS.get(code);
}

/** The stage Jumppoint's states give a state code. */
export function jumppointMappedStage(code: string): Stage | undefined {
  return STATES.get(code)?.[1];
}

/** A row's stage: its state, else the shared wording rules for a state the map does not know. */
export function jumppointStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = jumppointMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? jumppointMappedStage(code) : undefined),
  gaps: [...UNSTAGED].map(([code, [, note]]) => ({ code, note })),
};
