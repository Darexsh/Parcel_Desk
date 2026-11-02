import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Bosta's order states, as its API documentation lists them for webhooks. Some
 * mean another leg on a return: a picked-up order (41) is out for delivery on
 * a shipment and out for return on a return, and the warehouse and hub states
 * come on both legs. The tracking page words those scans for the leg, so the
 * wording is read first.
 */
const CODES: ReadonlyMap<number, Stage> = new Map([
  [10, 'registered'], // Pickup requested: the order waits for the merchant.
  [11, 'registered'], // Waiting for a route.
  [20, 'in_transit'], // Route assigned, at the warehouse: "being prepared for delivery".
  [21, 'accepted'], // Picked up from the merchant.
  [23, 'accepted'], // Picked up from the customer, for a return pickup or an exchange.
  [24, 'in_transit'], // Received at a warehouse.
  [30, 'in_transit'], // In transit between hubs.
  [41, 'out_for_delivery'],
  [45, 'delivered'],
  [46, 'returned'], // Returned to the merchant.
  [47, 'failed_attempt'], // A delivery that did not happen, for the reason the wording gives; the order goes out again or back.
  [48, 'exception'], // Terminated; the page says "Deleted" for an order the merchant deleted.
  [49, 'exception'], // Canceled.
  [60, 'returned'], // Returned to the merchant's stock at Bosta's fulfilment centre.
  [100, 'exception'], // Lost.
  [101, 'exception'], // Damaged.
  [102, 'exception'], // Under investigation.
  [103, 'exception'], // Awaiting the merchant's action after three failed returns.
  [104, 'exception'], // Archived.
  [105, 'exception'], // On hold.
]);

/** Codes the map leaves without a stage: no parcel is in Bosta's hands yet, or the code does not say where it is. */
const GAPS: ReadonlyMap<number, string> = new Map([
  [22, 'A courier on the way to collect a return or an exchange from the customer; the parcel is not in Bosta\'s hands yet.'],
  [25, 'A fulfilment order packed from the merchant\'s stock at Bosta; the scans around it say where it is.'],
  [40, 'A courier on the way to collect cash from the customer; there is no parcel.'],
]);

/** The page's wordings that settle a scan whose code alone could mean either leg, or that has no code. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['your shipper requested a pickup. bosta will pick it up soon', 'registered'],
  ['order is being prepared for delivery.', 'in_transit'],
]);

// The page's wording for a scan on the way back to the merchant: "Order is
// being returned to the shipper", "Order is out for return to the shipper".
const RETURN = /\breturn(?:ed)?\b.*\bshipper\b/;

/** The stage Bosta's map gives a scan's code and wording, in `normalizeStatusWording` form. */
export function bostaMappedStage(code: number | undefined, wording: string): Stage | undefined {
  const worded = WORDINGS.get(wording);
  if (worded) return worded;
  if (RETURN.test(wording)) return 'returned';
  return code === undefined ? undefined : CODES.get(code);
}

/** A scan's stage: the map, else the shared wording rules for a code the map does not know, else nothing. */
export function bostaStage(code: number | undefined, wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  const mapped = bostaMappedStage(code, normalized);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code !== undefined && GAPS.has(code)) return null;
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

/** The states that end an order, or stop it, whatever its scans say. */
const SUMMARIES: ReadonlyMap<number, Stage> = new Map([
  [45, 'delivered'], [46, 'returned'], [60, 'returned'],
  [48, 'exception'], [49, 'exception'], [100, 'exception'], [101, 'exception'],
  [102, 'exception'], [103, 'exception'], [104, 'exception'], [105, 'exception'],
]);

export function bostaSummaryStage(code: number | undefined): Stage | undefined {
  return code === undefined ? undefined : SUMMARIES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const number = code !== null && /^\d{1,3}$/.test(code) ? Number(code) : undefined;
    return code !== null && number === undefined ? undefined : bostaMappedStage(number, wording);
  },
  gaps: [
    ...[...GAPS].map(([code, note]) => ({ code: String(code), note })),
    { wording: 'order is under review', note: 'A draft order the merchant has not confirmed; it is not a shipment.' },
  ],
};
