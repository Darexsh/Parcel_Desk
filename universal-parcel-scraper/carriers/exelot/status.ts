import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Exelot's status codes, read from the titles and descriptions the tracker
 * page shows for them in English. A scan's code can carry a sub-code after an
 * underscore (`42_14`, a customs hold for a missing ID); the stage follows the
 * code before it. `R` codes belong to return shipments.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['00', 'registered'], // Shipment details received from the sender.
  ['01', 'registered'],
  ['05', 'in_transit'], // Departed the shipper's facility, on its way to Exelot.
  ['10', 'accepted'], // Received at the origin facility.
  ['11', 'exception'], // Not received from the sender; the buyer is told to ask the sender.
  ['12', 'in_transit'], // Arrived at a regional facility.
  ['13', 'in_transit'],
  ['14', 'accepted'], // Received at the origin facility, being prepared for export.
  ['15', 'in_transit'], // Flight details received.
  ['15-OLD', 'in_transit'],
  ['16', 'in_transit'],
  ['17', 'in_transit'], // Shipped to the destination country.
  ['21', 'in_transit'], // Arrived at a sorting facility.
  ['22', 'in_transit'],
  ['23', 'exception'], // On hold; the buyer is asked to get in touch.
  ['24', 'in_transit'],
  ['25', 'exception'],
  ['27', 'exception'],
  ['29', 'exception'], // Coming back to Exelot's facility; the buyer is asked to get in touch.
  ['31', 'exception'],
  ['32', 'customs'], // Customs clearance in progress.
  ['33', 'exception'],
  ['34', 'failed_attempt'], // Unable to deliver.
  ['35', 'customs'], // Arrived at the customs terminal.
  ['36', 'exception'],
  ['37', 'failed_attempt'],
  ['38', 'in_transit'], // Shipped to the destination country.
  ['39', 'in_transit'], // Arrived at a facility.
  ['40', 'customs'], // Held by customs.
  ['41', 'customs'], // Seized by customs.
  ['42', 'customs'], // Held by customs; sub-codes name the reason, such as an ID or a payment.
  ['43', 'in_transit'],
  ['44', 'in_transit'], // Back at the sorting facility; the delivery will be rescheduled.
  ['45', 'in_transit'], // Landed in the destination country.
  ['46', 'failed_attempt'], // Not delivered as planned and rescheduled.
  ['47', 'customs'],
  ['48', 'in_transit'], // Released from customs.
  ['49', 'in_transit'],
  ['50', 'out_for_delivery'],
  ['51', 'delivered'],
  ['52', 'delivered'],
  ['53', 'ready_for_pickup'], // Held for collection.
  ['54', 'exception'], // Abandoned.
  ['55', 'ready_for_pickup'], // Arrived at the collection point.
  ['58', 'exception'], // The phone number does not belong to the recipient.
  ['60', 'delivered'], // Collected from the collection point.
  ['64', 'exception'],
  ['65', 'exception'],
  ['66', 'failed_attempt'],
  ['67', 'exception'], // Refused by the recipient.
  ['68', 'failed_attempt'],
  ['69', 'failed_attempt'],
  ['70', 'failed_attempt'],
  ['71', 'exception'], // Being located.
  ['72', 'in_transit'], // Located, and on its way again.
  ['73', 'failed_attempt'],
  ['75', 'returned'],
  ['76', 'returned'],
  ['79', 'exception'], // Delivery issue.
  ['91', 'returned'],
  ['114', 'accepted'],
  ['210', 'in_transit'],
  ['211', 'in_transit'],
  ['215', 'in_transit'],
  ['350', 'customs'], // Awaiting customs clearance.
  ['363', 'failed_attempt'],
  ['369', 'out_for_delivery'], // Out for a second attempt.
  ['390', 'in_transit'],
  ['400', 'customs'], // Held by customs until its charges are paid.
  ['408', 'in_transit'], // The customs charges were paid and the parcel moves on.
  ['409', 'in_transit'], // The inspection fee was paid and the parcel moves on.
  ['410', 'returned'], // Sent back after the customs charges went unpaid.
  ['411', 'returned'], // Sent back for an invalid HS code.
  ['430', 'in_transit'],
  ['431', 'in_transit'],
  ['432', 'in_transit'],
  ['435', 'in_transit'], // Arrived at the local facility.
  ['690', 'failed_attempt'],
  ['691', 'failed_attempt'],
  ['692', 'failed_attempt'],
  ['693', 'failed_attempt'],
  ['694', 'failed_attempt'],
  ['R00', 'registered'],
  ['R21', 'in_transit'],
  ['R22', 'in_transit'],
  ['R38', 'accepted'], // The return was handed in at a collection point.
  ['R381', 'accepted'], // The return was handed in at a locker.
  ['R430', 'in_transit'],
  ['R431', 'in_transit'],
  ['R432', 'in_transit'],
  ['R50', 'in_transit'],
  ['R52', 'returned'], // The return reached the sender.
  ['R68', 'exception'], // The return was not handed in.
  ['R69', 'exception'], // The return window expired.
  ['R73', 'exception'], // The return was lost.
]);

/** The code a scan's stage follows: the part before its sub-code. */
export function exelotCodeKey(code: string): string {
  return code.split('_')[0]!.toUpperCase();
}

/** The stage of a scan's code, or nothing for one the map leaves out or does not know. */
export function exelotStage(code: string): Stage | undefined {
  return CODES.get(exelotCodeKey(code));
}

const NOTHING_MOVES = 'An administrative step the tracker shows without a description; it moves nothing.';

export const statusMap: CarrierStatusMap = {
  codeKey: exelotCodeKey,
  stage: (code) => (code ? exelotStage(code) : undefined),
  gaps: [
    { code: '74', note: 'Due for arrival: a forecast, not a scan.' },
    { code: '77', note: 'Due for arrival: a forecast, not a scan.' },
    { code: '78', note: 'A delay notice without a description; it moves nothing.' },
    { code: '81', note: 'The shipment details were updated; it moves nothing.' },
    { code: '90', note: NOTHING_MOVES },
    { code: '94', note: 'The shipment was closed, after a delivery or a return alike.' },
    { code: '95', note: 'The shipment was closed, after a delivery or a return alike.' },
    { code: '99', note: 'The shipment was closed, after a delivery or a return alike.' },
    { code: '218', note: 'The collection point was changed at the buyer\'s request; it moves nothing.' },
    { code: '324', note: NOTHING_MOVES },
    { code: '329', note: NOTHING_MOVES },
    { code: '699', note: 'The delivery was rescheduled at the buyer\'s request, not after a failed attempt.' },
    { code: 'R67', note: 'The return was cancelled; the parcel stays where it is.' },
    { code: 'R94', note: 'The return was closed, whatever became of it.' },
    { code: 'R99', note: 'The return was closed, whatever became of it.' },
  ],
};
