import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The rows of FleetOptics' tracking history, in English without a code. The
 * page puts its own wording on the service's statuses: a route the driver
 * started is "Out for Delivery", and a delivery or a failed visit carries its
 * reason after a dash.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  // The shipper sent the parcel's details; the summary says when it still has the parcel.
  [/^received order details$/, 'registered'],
  // A hub on the way to the local terminal, as "In Transit - Scanned at Transfer Terminal".
  [/^(?:in transit - )?scanned at transfer terminal$/, 'in_transit'],
  [/^scanned at delivery terminal$/, 'in_transit'],
  [/^out for delivery$/, 'out_for_delivery'],
  // Followed by the reason, as "Unable to Deliver - Business Closed"; the parcel goes out again.
  [/^unable to deliver - .+$/, 'failed_attempt'],
  // Followed by where the parcel was left, as "Delivered - Safe Drop".
  [/^delivered - .+$/, 'delivered'],
];

/** The stage FleetOptics' own wording gives a row, if the map knows it. */
export function fleetopticsMappedStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function fleetopticsStage(wording: string): ClassifiedWording | null {
  const mapped = fleetopticsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows come without a code, and every wording seen moves the parcel. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? fleetopticsMappedStage(wording) : undefined),
  gaps: [],
};
