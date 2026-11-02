import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes (`ExceptionId`) on a parcel's scans. A driver on the way to the
 * sender has not collected the parcel yet; a handover to a partner keeps it
 * moving towards the recipient. Every delivery wording of code 119 names
 * where the parcel was left.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  538: 'registered',
  910: 'registered',
  52: 'accepted',
  252: 'accepted',
  901: 'in_transit',
  903: 'in_transit',
  904: 'in_transit',
  90: 'in_transit',
  900: 'out_for_delivery',
  119: 'delivered',
};

/** Scans that move nothing: the parcel keeps the stage of the scan before them. */
const QUIET: Readonly<Record<string, string>> = {
  720: 'Delivery notifications sent to the consignee: a message to the recipient, which moves nothing.',
  730: 'Picture taken: a photo at the pickup or the delivery, next to the scan that records it.',
};

/**
 * The state Nationex gives the shipment and each parcel, which its tracker
 * shows as the current step. Partial states belong to shipments of several
 * parcels: the tracker groups a partial pickup, transit or delivery round with
 * the full one. A partial delivery leaves parcels on their way, so it is not a
 * delivery. A failed pickup, a refusal, a damaged parcel ("Attention") and a
 * shipment on hold are problems; codes 500 and 501 are cancellations.
 */
const STATES: Readonly<Record<string, Stage>> = {
  Creation: 'registered',
  OutForPickup: 'registered',
  Pickup: 'accepted',
  PartiallyPickedUp: 'accepted',
  Transit: 'in_transit',
  PartiallyInTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  PartiallyOutForDelivery: 'out_for_delivery',
  PartiallyDelivered: 'in_transit',
  Delivered: 'delivered',
  ReturnToSender: 'returned',
  ReturnCompleted: 'returned',
  Attention: 'exception',
  RefusedDelivery: 'exception',
  PickupAttemptFailed: 'exception',
  OnHold: 'exception',
  Cancelled: 'exception',
  500: 'exception',
  501: 'exception',
};

/** The stage the map gives a scan's code, if it knows it. */
export function nationexScanStage(code: string): Stage | undefined {
  return Object.hasOwn(SCANS, code) ? SCANS[code] : undefined;
}

/** Whether a scan's code moves nothing. */
export function nationexQuiet(code: string): boolean {
  return Object.hasOwn(QUIET, code);
}

// The tracker's English names of the states. Partial states have none; their
// own name is spelt out instead.
const LABELS: Readonly<Record<string, string>> = {
  Creation: 'Creation', OutForPickup: 'Out for pickup', Pickup: 'Picked up', Transit: 'In transit',
  OutForDelivery: 'Out for delivery', Delivered: 'Delivered', ReturnToSender: 'Return To Sender',
  ReturnCompleted: 'Return Completed', Attention: 'Attention', RefusedDelivery: 'Refused delivery',
  PickupAttemptFailed: 'Pickup attempt failed', OnHold: 'On hold', Cancelled: 'Cancelled', 500: 'Cancelled', 501: 'Cancelled',
};

/** The name the tracker shows for a state, else the state's own name in words. */
export function nationexStateLabel(state: string): string {
  if (Object.hasOwn(LABELS, state)) return LABELS[state]!;
  const [first = '', ...rest] = state.split(/(?=[A-Z])/);
  return [first, ...rest.map((word) => word.toLowerCase())].join(' ');
}

/** The stage of a shipment's or parcel's state, if the map knows it. */
export function nationexStateStage(state: string): Stage | undefined {
  return Object.hasOwn(STATES, state) ? STATES[state] : undefined;
}

/**
 * A scan's stage from its code, else from the shared wording rules. A quiet
 * scan, and wording neither knows, stays without a stage.
 */
export function nationexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = nationexScanStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (nationexQuiet(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its code alone. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? nationexScanStage(code) : undefined),
  gaps: Object.entries(QUIET).map(([code, note]) => ({ code, note })),
};
