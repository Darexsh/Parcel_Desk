import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker groups a parcel's scans under milestones, each with a heading
 * (`main_status`) and a number (`main_status_id`). The numbers seen in
 * replies are mapped; the others fall to the heading.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['2', 'in_transit'], // In Transit: taken in at, or sent on from, a Shadowfax facility.
  ['7', 'delivered'],
  // Delivery failed: Shadowfax gave up the delivery and sends the parcel back to the seller.
  ['8', 'exception'],
]);

/**
 * The milestone headings the tracker's script names, and the earlier ones
 * TrackingMore lists. Picking an order up from the seller, or a return from
 * the buyer, is the parcel's acceptance. A pickup that failed, was cancelled
 * or waits on hold has no parcel moving.
 */
const HEADINGS: ReadonlyMap<string, Stage> = new Map([
  ['order received', 'registered'],
  ['shipment has been picked', 'accepted'],
  ['item picked', 'accepted'],
  ['in transit', 'in_transit'],
  ['near you', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['order delivered', 'delivered'],
  ['delivery attempt failed', 'failed_attempt'],
  ['delivery unsuccessful', 'failed_attempt'],
  ['delivery failed', 'exception'],
  ['order cancelled', 'exception'],
  ['pick up unsuccessful', 'exception'],
  ['pick up canceled', 'exception'],
  ['pick up is on hold', 'exception'],
  ['pick up is on hold as customer contact number is incorrect', 'exception'],
]);

/**
 * The summary's `status_id`, which the page reads for the parcel's state. It
 * only stages a parcel whose newest scan has no stage. `ofp`, a rider on the
 * way to collect a return, moves nothing yet.
 */
const SUMMARY: ReadonlyMap<string, Stage> = new Map([
  ['picked', 'accepted'],
  ['in_transit', 'in_transit'],
  ['ofd', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['undelivered', 'failed_attempt'],
  ['delivery_failed', 'exception'],
  ['cancelled', 'exception'],
  ['on_hold', 'exception'],
]);

const key = (heading: string) => heading.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ').replace(/\.+$/, '');

/** The stage a milestone's number gives, if the map knows it. */
export function shadowfaxCodeStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

/** The stage a milestone's heading gives, if the map knows it. */
export function shadowfaxHeadingStage(heading: string): Stage | undefined {
  return HEADINGS.get(key(heading));
}

/** The stage the summary's `status_id` gives, if the map knows it. */
export function shadowfaxSummaryStage(statusId: string): Stage | undefined {
  return SUMMARY.get(statusId.trim().toLowerCase());
}

/** A scan's stage: its milestone's number, else its heading, else the shared wording rules, else nothing. */
export function shadowfaxStage(code: string, heading: string, wording: string): ClassifiedWording | null {
  const mapped = (code ? shadowfaxCodeStage(code) : undefined) ?? shadowfaxHeadingStage(heading);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** A scan's wording starts with its milestone's heading, before `: `. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? shadowfaxCodeStage(code) : undefined) ?? shadowfaxHeadingStage(wording.split(': ', 1)[0]!),
  gaps: [],
};
