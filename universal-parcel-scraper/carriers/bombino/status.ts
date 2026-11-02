import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Bombino's event states, with the label the tracking page's script gives
 * each. The reply writes them in snake case (`shipment_hold`); the page, and
 * this map, compare them without case, spaces, underscores or hyphens.
 */
const STATES: ReadonlyMap<string, { readonly stage: Stage; readonly label: string }> = new Map([
  ['entry', { stage: 'registered', label: 'Shipment information received' }],
  ['pickupscan', { stage: 'accepted', label: 'Picked up' }],
  ['inscan', { stage: 'in_transit', label: 'Received at facility' }],
  ['branchmanifest', { stage: 'in_transit', label: 'Forwarded to hub' }],
  ['awaitingconnection', { stage: 'in_transit', label: 'Awaiting connection' }],
  ['manifest', { stage: 'in_transit', label: 'Prepared for departure' }],
  ['remanifest', { stage: 'in_transit', label: 'Prepared for departure' }],
  ['transfermanifest', { stage: 'in_transit', label: 'Connected locally' }],
  ['incomingmanifest', { stage: 'in_transit', label: 'Arrived at hub' }],
  ['incomingtransfermanifest', { stage: 'in_transit', label: 'Arrived at hub' }],
  ['reincomingmanifest', { stage: 'in_transit', label: 'Arrived at hub' }],
  ['intransit', { stage: 'in_transit', label: 'In transit' }],
  ['offloaded', { stage: 'in_transit', label: 'Offloaded — awaiting next connection' }],
  // A hold for documents, payment or the account's credit; the page warns until an unhold follows.
  ['shipmenthold', { stage: 'exception', label: 'On hold' }],
  ['hold', { stage: 'exception', label: 'On hold' }],
  ['shipmentunhold', { stage: 'in_transit', label: 'Hold cleared — moving again' }],
  ['drs', { stage: 'out_for_delivery', label: 'Out for delivery' }], // Delivery run sheet.
  ['redrs', { stage: 'out_for_delivery', label: 'Out for delivery' }],
  ['delivered', { stage: 'delivered', label: 'Delivered' }],
  ['undelivered', { stage: 'failed_attempt', label: 'Delivery attempted — could not deliver' }],
  // Return to origin, on its way back or at the shipper's request.
  ['rto', { stage: 'returned', label: 'Being returned to sender' }],
  ['undeliveredintransitrto', { stage: 'returned', label: 'Being returned to sender' }],
  ['partrto', { stage: 'returned', label: 'Partially returned to sender' }],
  ['missplaced', { stage: 'exception', label: 'Delayed — locating shipment' }],
  ['lost', { stage: 'exception', label: 'Delayed — under investigation' }],
  ['cancelled', { stage: 'exception', label: 'Cancelled' }],
  ['abandoned', { stage: 'exception', label: 'Shipment closed' }],
]);

/** An event state as the page compares it: lower case, without spaces, underscores or hyphens. */
export function bombinoStateKey(code: string): string {
  return code.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** The page's label for an event state, for a scan that comes without wording. */
export function bombinoStateLabel(code: string): string | undefined {
  return STATES.get(bombinoStateKey(code))?.label;
}

// The page files a scan whose wording names customs or a clearance under
// customs, whatever its state: a hold or a clearance in progress can come
// under another state. A parcel customs cleared or released keeps its state's stage.
const CUSTOMS = /custom|clearance/i;
const CLEARED = /\b(?:cleared|released)\b/i;

function customsStage(wording: string): ClassifiedWording | null {
  if (!CUSTOMS.test(wording) || CLEARED.test(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The stage Bombino's map gives a scan's state and wording. */
export function bombinoMappedStage(code: string, wording = ''): Stage | undefined {
  return customsStage(wording)?.stage ?? STATES.get(bombinoStateKey(code))?.stage;
}

/** A scan's stage: customs wording, else its state, else the shared wording rules, else nothing. */
export function bombinoStage(code: string, wording: string): ClassifiedWording | null {
  const customs = customsStage(wording);
  if (customs) return customs;
  const mapped = STATES.get(bombinoStateKey(code))?.stage;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: bombinoStateKey,
  stage: (code, wording) => (code ? bombinoMappedStage(code, wording) : undefined),
  gaps: [],
};
