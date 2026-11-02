import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * MailAmericas' event codes: a family for the leg of the journey and a number
 * within it. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OC-1', 'registered'], // Label generated; the seller has not handed the parcel over yet.
  ['WH-1', 'accepted'], // Received at the origin warehouse.
  ['WH-2', 'in_transit'], // Dispatched from the origin warehouse.
  ['WH-3', 'in_transit'], // Processed at the origin warehouse.
  ['HB-1', 'in_transit'], // Received at a transit hub.
  ['HB-2', 'in_transit'], // Processed at a transit hub.
  ['HB-3', 'in_transit'], // Dispatched from a transit hub.
  ['HB-4', 'in_transit'], // Inspected at a transit hub.
  ['TD-1', 'in_transit'], // On the way to the airport.
  ['TD-2', 'customs'], // Export clearance in the origin country.
  ['TD-3', 'in_transit'], // Transshipment.
  ['TD-4', 'in_transit'], // Flight.
  ['AR-1', 'in_transit'], // Handed over by the airline in the destination country.
  ['AR-2', 'customs'], // Presented to customs on arrival.
  ['AD-1', 'customs'], // Received by destination customs.
  ['AD-2', 'customs'], // Held for a customs review.
  ['AD-3', 'in_transit'], // Released by customs.
  ['AD-7', 'in_transit'], // Handed from customs to the last-mile provider.
  ['WI-2', 'in_transit'], // The container reached an intermediate warehouse in the destination country.
  ['WI-3', 'in_transit'], // Received at the intermediate warehouse.
  ['WI-4', 'in_transit'], // Processed at an intermediate warehouse.
  ['RC-0', 'in_transit'], // Sent to the last-mile provider.
  ['RC-1', 'in_transit'], // Received by the last-mile provider.
  ['RC-2', 'in_transit'], // At the last-mile provider's sorting centre.
  ['RC-3', 'in_transit'], // On the way to the delivery office.
  ['RC-4', 'in_transit'], // Sent on a corrected route.
  ['LM-1', 'in_transit'], // Received at the delivery office.
  ['LM-2', 'out_for_delivery'], // With the postman.
  ['LM-3', 'failed_attempt'], // A delivery attempt that did not deliver; a delivery scan follows one that did.
  ['LM-4', 'ready_for_pickup'], // Waiting at the delivery office for collection.
  ['LM-5', 'returned'], // Sent back after failed deliveries.
  ['LM-7', 'failed_attempt'], // The recipient was not in.
  ['LM-9', 'failed_attempt'], // The address was wrong; the parcel can go out again.
  ['PF-1', 'delivered'],
  ['PF-2', 'returned'], // Delivered to the return address.
  ['RT-1', 'returned'], // Received at the return warehouse.
  ['RT-3', 'exception'], // To be destroyed instead of sent back.
]);

/** The stage MailAmericas' codes give a scan code. */
export function mailamericasMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

// Tax ID checks (SM), notices (AV), the record of a prepaid duty (AD-4,
// seen while the parcel was still at the origin warehouse) and a delivery
// moved to a later round (LM-11) move nothing.
const NOTICE = /^(?:SM-|AV-|AD-4$|LM-11$)/i;

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function mailamericasStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = mailamericasMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE.test(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? mailamericasMappedStage(code) : undefined),
  gaps: [
    { code: 'SM-1', note: 'A check of the buyer\'s tax ID at order creation; the parcel moves on whatever it says.' },
    { code: 'SM-2', note: 'A check of the buyer\'s tax ID at order creation; the parcel moves on whatever it says.' },
    { code: 'SM-4', note: 'A check of the buyer\'s tax ID; the parcel moves on whatever it says.' },
    { code: 'SM-9', note: 'The buyer\'s details form received, logged again every half hour while the parcel moves on; it moves nothing.' },
    { code: 'AD-4', note: 'The import duty recorded as paid, which can come while the parcel is still at the origin warehouse; it moves nothing.' },
    { code: 'AV-1', note: 'A notice that adds information to the history; it moves nothing.' },
    { code: 'LM-11', note: 'The delivery moved to a later round, logged after a round or beside the next one, which can deliver; it names no attempt and moves nothing.' },
  ],
};
