import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const wording: Record<string, ClassifiedStatus> = {
  'The shipment has been delivered': { status: 'delivered', stage: 'delivered' },
  "An Aramex Delivery Champion has the shipment and is expected to reach the customer's doorstep shortly": { status: 'out_for_delivery', stage: 'out_for_delivery' },
  "We've attempted to deliver the shipment, but the customer was not available at the time. Not to worry, the delivery has been rescheduled": { status: 'exception', stage: 'failed_attempt' },
  'Updated delivery address required from customer': { status: 'exception', stage: 'exception' },
  'The shipment is currently going through customs inspection': { status: 'in_transit', stage: 'customs' },
  'The shipment is on its way to our Aramex facility': { status: 'in_transit', stage: 'in_transit' },
  'The shipment has arrived at the Aramex office at the destination and is being prepared for customer pickup/delivery': { status: 'in_transit', stage: 'in_transit' },
  'The shipment has left the Aramex transit office and is now on its way to the final destination country': { status: 'in_transit', stage: 'in_transit' },
  'The shipment has reached Aramex transit office and is on its way to the final destination office': { status: 'in_transit', stage: 'in_transit' },
  'The shipment is being processed and on its way to the next destination': { status: 'in_transit', stage: 'in_transit' },
  'Shipment collected from the shipper': { status: 'in_transit', stage: 'accepted' },
  // Collection or delivery is still to come.
  "Shipment is on its way to the final destination's sorting facility and will be updated once ready for collection/delivery": { status: 'in_transit', stage: 'in_transit' },
  'Shipment Confiscated by Customs Authorities': { status: 'exception', stage: 'exception' },
  'An issue was encountered which prevented the processing of this shipment This is the last update, for further information, please contact your local Aramex office': { status: 'exception', stage: 'exception' },
  // A new delivery day, with no attempt reported.
  'The delivery has to be rescheduled for the following business day': { status: 'in_transit', stage: 'in_transit' },
  // The address request is answered, so an earlier exception no longer holds.
  'The delivery address has been updated': { status: 'in_transit', stage: 'in_transit' },
};

// Notes beside the parcel's movement: contact with the customer, payments,
// checks and network notices. They stage nothing.
const notes = new Set([
  'One of our Aramex delivery champion has contacted the customer and they have responded',
  'The customer contacted one of our Aramex delivery champion and contact was made successfully',
  'Customer ID received',
  'Shipment charges paid',
  'The value of the shipment has been successfully confirmed',
  'The status of the shipment\\delivery is currently being reviewed',
  'Shipment situation update: Due to Geopolitical situation flights are cancelled to UAE / please expect delay',
]);

export function isAramexNote(value: string): boolean {
  return notes.has(value);
}

export function classifyAramexStatus(value: string): ClassifiedStatus | undefined {
  return wording[value];
}

const STAGE_BY_WORDING = new Map<string, Stage>(Object.entries(wording).map(([text, status]) => [normalizeStatusWording(text), status.stage]));

/**
 * What the map says about one scan: its exact wording, as the parser reads it. A note stages
 * nothing and leaves the parcel at the stage of the scan before it, which the stored note does
 * not keep.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, text) => STAGE_BY_WORDING.get(text),
  gaps: [...notes].map((text) => ({
    wording: normalizeStatusWording(text),
    note: 'A note beside the movement, on contact, payment, a check or the network: the parcel keeps the stage of the scan before it, which the stored note does not keep.',
  })),
};
