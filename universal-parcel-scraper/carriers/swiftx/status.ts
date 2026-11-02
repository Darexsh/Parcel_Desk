import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A scan's provider code is the tracker's event code. SwiftX labels a parcel,
 * receives it at a hub from the shipper or its linehaul, moves it between hubs,
 * sorts it at a warehouse and delivers it from there. It takes over parcels a
 * cross-border line has already carried to the United States, so its receipt
 * is in transit, as the line relays it and as other last-mile carriers' hub
 * receipts read.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  CREATED: 'registered',
  PICKUP_ARRIVAL_SCAN: 'in_transit',
  SORTING_CENTER_SIGNED_SCAN: 'in_transit',
  SORTING_CENTER_INBOUND_SCAN: 'in_transit',
  ORIGIN_HUB_DEPARTURE: 'in_transit',
  DISPATCH_SCAN: 'in_transit',
  TRANSFER_ARRIVAL_SCAN: 'in_transit',
  DESTINATION_HUB_DEPARTURE: 'in_transit',
  WHS_ARRIVAL_SCAN: 'in_transit',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_FAILED: 'failed_attempt',
  DELIVERED: 'delivered',
  RETURN_SHIPPED: 'returned',
  RETURN_RECEIVED: 'returned',
};

/**
 * `DELIVERY_FAILED` also marks an exception. The tracker gives this wording,
 * alone, a notice that SwiftX is looking for the parcel.
 */
const MISSING = 'package missing';

/** Scans that move nothing: the parcel keeps the stage of the scan before them. */
const QUIET: Readonly<Record<string, string>> = {
  PICKUP_FAILED: 'A scheduled pickup at the shipper did not happen: the parcel stays where it was.',
};

/** The stage the map gives a code and its wording, if it knows one. */
export function swiftxScanStage(code: string, wording: string): Stage | undefined {
  if (code === 'DELIVERY_FAILED' && normalizeStatusWording(wording) === MISSING) return 'exception';
  return Object.hasOwn(SCANS, code) ? SCANS[code] : undefined;
}

/**
 * A scan's stage: `quiet` when it moves nothing, else the map's, else the
 * shared wording rules' for a code the map does not know (null when neither
 * knows it).
 */
export function swiftxStage(code: string, wording: string): ClassifiedWording | 'quiet' | null {
  if (Object.hasOwn(QUIET, code)) return 'quiet';
  const mapped = swiftxScanStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? swiftxScanStage(code, wording) : undefined),
  gaps: Object.entries(QUIET).map(([code, note]) => ({ code, note })),
};
