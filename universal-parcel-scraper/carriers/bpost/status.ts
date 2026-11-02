import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: Record<string, ClassifiedStatus> = {
  'Item delivered': { status: 'delivered', stage: 'delivered' },
  'Item delivered in mailbox': { status: 'delivered', stage: 'delivered' },
  // Left at the safe place the recipient chose.
  'Item delivered at safeplace': { status: 'delivered', stage: 'delivered' },
  // Left with a neighbour, whose name and address the notice in the mailbox gives.
  'Your parcel was delivered at one of your neighbours. You can find all delivery details in your mailbox.': { status: 'delivered', stage: 'delivered' },
  'Item available at Pick-up point': { status: 'in_transit', stage: 'ready_for_pickup' },
  // On its way to a locker, then waiting in it, with the brand the parser puts in place of
  // bpost's placeholder.
  "Item on it's way to Parcel Locker": { status: 'in_transit', stage: 'in_transit' },
  "Item on it's way to bbox locker": { status: 'in_transit', stage: 'in_transit' },
  "Item on it's way to parcel locker": { status: 'in_transit', stage: 'in_transit' },
  'Item available at the Parcel Locker': { status: 'in_transit', stage: 'ready_for_pickup' },
  'Item available at the bbox locker': { status: 'in_transit', stage: 'ready_for_pickup' },
  'Item available at the parcel locker': { status: 'in_transit', stage: 'ready_for_pickup' },
  "The postman's delivery round for your item has started": { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // A delivery abroad that did not happen, as bpost words the partner's attempt: CTT's own
  // "delivery not achieved" comes at the same minute, then the item waits at a pick-up point.
  'Out for delivery - delivery not possible': { status: 'exception', stage: 'failed_attempt' },
  'Shipment presented without success. Addressee is informed.': { status: 'exception', stage: 'failed_attempt' },
  // The item stays at the distribution center, off every delivery round, until the information
  // it lacks is found: a hold the recipient should see, not a step in transit.
  "Item arrived at the distribution center - Item can't be assigned to a delivery round - missing information": { status: 'exception', stage: 'exception' },
  // The post abroad could not deliver to the address it was given, and sent the item back to
  // Landmark Global, bpost's cross-border network: the item is on its way back.
  'Irregularity item : problem address': { status: 'exception', stage: 'exception' },
  'Returned to Landmark Global (bpost), Incorrect / illegible / incomplete address': { status: 'exception', stage: 'returned' },
  'Your shipment has arrived at the postal operator of the country of destination and will be delivered in the coming days': { status: 'in_transit', stage: 'in_transit' },
  'Your item has been sorted': { status: 'in_transit', stage: 'in_transit' },
  // A return label's parcel sorted on its way to the shop that issued the label, which bpost
  // calls the sender: the label's own trip, not a parcel sent back.
  'The return item has been sorted and will be made available for the sender': { status: 'in_transit', stage: 'in_transit' },
  'Item is ready for transport': { status: 'in_transit', stage: 'in_transit' },
  'Shipment ready for transport': { status: 'in_transit', stage: 'in_transit' },
  'Departure to country of destination': { status: 'in_transit', stage: 'in_transit' },
  'Arrival at international depot': { status: 'in_transit', stage: 'in_transit' },
  // Mail from abroad waits for customs at the international depot, which clears it
  // without charges before it leaves for the national network.
  'Awaiting presentation to Customs': { status: 'in_transit', stage: 'customs' },
  'No extra costs': { status: 'in_transit', stage: 'in_transit' },
  'Departure to distribution network': { status: 'in_transit', stage: 'in_transit' },
  'Parcel is handled': { status: 'in_transit', stage: 'in_transit' },
  'Arrival at facilities': { status: 'in_transit', stage: 'in_transit' },
  'Item has passed a checkpoint': { status: 'in_transit', stage: 'in_transit' },
  'Landmark Global (bpost) has received the item': { status: 'in_transit', stage: 'accepted' },
  // The sender's drop-off, then bpost's acceptance of it a day later.
  'Drop off item by the customer': { status: 'in_transit', stage: 'accepted' },
  'Item accepted after deposit by sender': { status: 'in_transit', stage: 'accepted' },
  'Confirmation of preparation of the shipment received': { status: 'pending', stage: 'registered' },
  'Item is announced / Landmark Global (bpost) received the information': { status: 'pending', stage: 'registered' },
};

export function classifyBpostStatus(description: string): ClassifiedStatus | undefined {
  return Object.hasOwn(WORDINGS, description) ? WORDINGS[description] : undefined;
}

const STAGE_BY_WORDING = new Map(Object.entries(WORDINGS).map(([wording, { stage }]) => [normalizeStatusWording(wording), stage]));

/**
 * What the map says about one scan by its English wording, the only key a scan has. Wording
 * that still holds bpost's locker placeholder reads as the parser reads a locker of unknown brand.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : STAGE_BY_WORDING.get(wording.replaceAll('{{bboxrebrand}}', 'parcel locker'))),
  gaps: [],
};
