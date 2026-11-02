/**
 * India Post status vocabulary.
 *
 * The tracking rows carry no stable status code: `event_type`, `event` and
 * `remarks` are all English prose that India Post words differently per office.
 * So this classifier normalizes the three of them into one alphanumeric key and
 * matches substrings, most specific first — returns and failures before
 * deliveries, deliveries before pickups, pickups before generic movement.
 *
 * The fallback is `{ status: 'unknown', stage: 'in_transit' }`: every row here
 * is a physical scan, so "something moved" is the safe reading, while the
 * `unknown` status lets the caller see that nothing was actually recognized.
 *
 * Provenance: the MySpeedPost Livewire tracker inspected 2026-09-01, with
 * https://github.com/bivu-m/njs-tracker-scraper as the starting point.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { cleanScalar } from '../../core/transport/text.js';

function statusKey(value: unknown): string {
  return cleanScalar(value, 200).toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

/** The values' words, camel case split, for a cue too short to find inside joined words ("From LOS To"). */
function statusWords(values: unknown[]): string[] {
  return values.flatMap((value) => cleanScalar(value, 200).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase('en-US').split(/[^a-z0-9]+/)).filter(Boolean);
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

/**
 * Classify one row from its `event_type`, `event` and `remarks`. Never
 * undefined: an unrecognized row falls back to an `unknown` status on an
 * `in_transit` stage.
 */
export function classifyIndiaPostEvent(...values: unknown[]): ClassifiedStatus {
  if (statusKey(values[0]) === 'aircrafttakeoff') return { status: 'in_transit', stage: 'in_transit' };
  const key = values.map(statusKey).filter(Boolean).join(' ');
  if (includesAny(key, [
    'returntosender',
    'returnedtocustomer',
    'returnedtobookingoffice',
    'returnitem',
  ])) return { status: 'exception', stage: 'returned' };
  if (includesAny(key, [
    'insufficientaddress',
    'addresseecannotbelocated',
    'damaged',
    'refused',
  ]) || statusWords(values).includes('lost')) return { status: 'exception', stage: 'exception' };
  if (includesAny(key, [
    'deliveryattempted',
    'deliveryfailed',
    'notdelivered',
    'undelivered',
  ])) return { status: 'exception', stage: 'failed_attempt' };
  if (includesAny(key, [
    'itemdelivered',
    'deliveredtorecipient',
    'delivereddelivery',
  ])) return { status: 'delivered', stage: 'delivered' };
  if (includesAny(key, [
    'readyforpickup',
    'readyforcollection',
    'awaitingcollection',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  if (includesAny(key, [
    'outfordelivery',
    'itemoutfordelivery',
    'sentfordelivery',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  // Customs handing the item back (CUSTOM_RETURN, "returned from export
  // Customs/Security", "released by export Customs") ends the customs step.
  if (includesAny(key, [
    'customreturn',
    'returnedfromexportcustoms',
    'returnedfromcustoms',
    'releasedbyexportcustoms',
    'releasedbycustoms',
    'outofexportcustoms',
  ])) return { status: 'in_transit', stage: 'in_transit' };
  if (includesAny(key, ['customs', 'customclearance', 'customreceive'])) {
    return { status: 'in_transit', stage: 'customs' };
  }
  if (includesAny(key, ['itembook', 'articlebooked', 'bookingconfirmed'])) {
    return { status: 'pending', stage: 'accepted' };
  }
  if (includesAny(key, [
    'shipmentinformationreceived',
    'labelcreated',
    'articlecreated',
    'consignmentcreated',
  ])) return { status: 'pending', stage: 'registered' };
  if (includesAny(key, [
    'itembagged',
    'itemdispatched',
    'itemreceived',
    'receivedat',
    'departed',
    'arrived',
    'forwarded',
    'intransit',
    'handedover',
    // Codes India Post sends since 2026-09 (BAG_DISPATCH, TRANSFER_OOE...).
    'inducted',
    'bagclose',
    'bagdispatch',
    'bagforward',
    'tmoreceive',
    'itemreceive',
    'transferooe',
    // Movement codes seen since: bags received and unloaded, an item sent on to the
    // domestic network or to the office of exchange, a load plan and a finished leg.
    'bagreceived',
    'bagunloaded',
    'senditemtodomestic',
    'itemtransfer',
    'transfertoooe',
    'assignedtoloadplan',
    'transportlegcompleted',
  ])) return { status: 'in_transit', stage: 'in_transit' };
  return { status: 'unknown', stage: 'in_transit' };
}

// India Post now sends bare codes in `event` (seen 2026-09-22 after a refresh);
// rows synced earlier carry its prose. Only codes seen live are spelled out.
const EVENT_TEXT: Record<string, string> = {
  ITEM_BOOK: 'Item Booked',
  BAG_CLOSE: 'Bag Closed',
  BAG_DISPATCH: 'Bag Dispatched',
  BAG_FORWARD: 'Bag Forwarded',
  TMO_RECEIVE: 'Received at Transit Mail Office',
  ITEM_RECEIVE: 'Item Received',
  CUSTOM_RECEIVE: 'Item Presented to Customs',
  CUSTOM_RETURN: 'Item Returned from Customs',
  TRANSFER_OOE: 'Transferred to Office of Exchange',
};

/** Readable text for a code-shaped event such as `BAG_DISPATCH`; prose passes through. */
export function indiaPostEventText(raw: string): string {
  if (!/^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/.test(raw)) return raw;
  const code = raw.toUpperCase();
  return EVENT_TEXT[code] ?? code.toLowerCase().split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// The code a spelled-out wording stands for: the adapter classified the code, which can read
// differently, as `TRANSFER_OOE` does.
const EVENT_CODES = new Map(Object.entries(EVENT_TEXT).map(([code, text]) => [normalizeStatusWording(text), code]));

/**
 * What the map says about one scan: its `event_type` code and wording, read as the adapter reads a
 * row whose remarks add nothing. A remark, which the stored scan does not keep, can give a row
 * another stage, such as a return or an exception. The adapter keeps a row it does not recognize
 * in transit so no scan is dropped; the map leaves that row open, so the app's review shows the
 * India Post wording no rule knows instead of a stage nothing read.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const classified = classifyIndiaPostEvent(code, wording, EVENT_CODES.get(wording));
    return classified.status === 'unknown' ? undefined : classified.stage;
  },
  gaps: [],
};
