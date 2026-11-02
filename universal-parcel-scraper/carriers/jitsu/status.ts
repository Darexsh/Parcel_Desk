import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A scan's provider code is its event type and signal, `OUTBOUND.DROPOFF_SUCCEEDED`
 * for instance: the tracker's wording templates are keyed the same way. Jitsu
 * plans a delivery, receives the parcel at its facility (inbound), loads it on
 * a route and delivers it (outbound). A route "pickup" is the driver collecting
 * the parcel at Jitsu's facility for the round, and a "return" the driver
 * bringing it back there after a failed delivery, for another attempt. `OTHER`
 * scans relay the linehaul carrier that brings the parcel to Jitsu.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  'PLANNING.CREATED': 'registered',
  'PLANNING.GEOCODED': 'registered',
  'PLANNING.UNSERVICEABLE': 'exception',
  'OTHER.IN_TRANSIT': 'in_transit',
  'INBOUND.RECEIVED_OK': 'in_transit',
  'INBOUND.FIRST_SCAN': 'in_transit',
  'INBOUND.PRESORT_SCAN': 'in_transit',
  'INBOUND.REGIONAL_SCAN': 'in_transit',
  'INBOUND.INFERRED_SCAN': 'in_transit',
  'INBOUND.RECEIVED_DAMAGED': 'exception',
  'INBOUND.DAMAGED': 'exception',
  'INBOUND.LOST': 'exception',
  'OUTBOUND.PICKUP_SCHEDULED': 'in_transit',
  'OUTBOUND.PICKUP_SUCCEEDED': 'out_for_delivery',
  'OUTBOUND.DROPOFF_EN_ROUTE': 'out_for_delivery',
  'OUTBOUND.DROPOFF_READY': 'out_for_delivery',
  'OUTBOUND.DROPOFF_REATTEMPTING': 'out_for_delivery',
  'OUTBOUND.DROPOFF_SUCCEEDED': 'delivered',
  'OUTBOUND.DROPOFF_FAILED': 'failed_attempt',
  'OUTBOUND.RETURN_SUCCEEDED': 'in_transit',
  'OUTBOUND.RETURN_FAILED': 'exception',
  'OUTBOUND.RETURN_DAMAGED': 'exception',
  'OUTBOUND.UNDELIVERABLE': 'exception',
  'OUTBOUND.DISPOSABLE': 'exception',
};

/** Scans that move nothing: the parcel keeps the stage of the scan before them. */
const QUIET: Readonly<Record<string, string>> = {
  'INBOUND.MISSING': 'Jitsu is still waiting to receive the parcel at its warehouse: a notice, not a movement.',
  'INBOUND.NOT_RECEIVED': 'Jitsu is still waiting for the parcel: a notice, not a movement.',
  'INBOUND.MANIFEST_NOT_RECEIVED': 'Jitsu is still waiting for the parcel and has updated the delivery date: a notice.',
  'INBOUND.NO_ACTIVITY': 'The parcel may be delayed: a notice, not a movement.',
  'INBOUND.SHIPMENT_ROLLED': 'The delivery date moved, whether or not the parcel has arrived: a notice.',
  'OUTBOUND.PICKUP_DELAY': 'The round runs late: a notice, not a movement.',
  'OUTBOUND.DRIVER_DELAY': 'The parcel may be delayed: a notice, not a movement.',
  'OUTBOUND.DROPOFF_DELAY': 'The delivery runs late: a notice, not a movement.',
  'RECYCLE.GATHER_NOTICE': 'A request to leave a recycling bag out for collection, not about the parcel.',
  'RECYCLE.GATHER_COMPLETED': 'A recycling bag or return capsule was collected, not the parcel.',
  'RECYCLE.GATHER_FAILED': 'A recycling bag or return capsule could not be collected, not the parcel.',
  'RECYCLE.GATHER_FLAGGED': 'A recycling bag or return capsule collection was flagged, not the parcel.',
};

/**
 * Codes whose stage depends on the scans before them, as on the tracker. A new
 * plan after the parcel has moved, such as after it came back for another
 * attempt, moves nothing. A failed route pickup of a parcel the facility has
 * received moves nothing either; before that, the parcel is missing.
 */
const CONTEXTUAL: Readonly<Record<string, string>> = {
  'PLANNING.GEOCODED': 'A delivery plan: the label before the parcel moves, a new plan that moves nothing after.',
  'OUTBOUND.PICKUP_FAILED': 'A round that left without the parcel: nothing moves once the facility has it, a problem before.',
};

/** The provider code of a scan: its type and signal. */
export function jitsuCode(type: string, signal: string): string {
  return `${type}.${signal}`;
}

/** The stage the map gives a code on its own, if it knows one. */
export function jitsuScanStage(code: string): Stage | undefined {
  return Object.hasOwn(SCANS, code) ? SCANS[code] : undefined;
}

/** Whether a scan's code moves nothing. */
export function jitsuQuiet(code: string): boolean {
  return Object.hasOwn(QUIET, code);
}

/**
 * A scan's stage, given whether the parcel has moved and whether Jitsu's
 * facility has received it: `quiet` when it moves nothing, else the map's
 * stage, else the shared wording rules' (null when neither knows it).
 */
export function jitsuStage(code: string, wording: string, before: { moved: boolean; received: boolean }): ClassifiedWording | 'quiet' | null {
  if (jitsuQuiet(code)) return 'quiet';
  if (code === 'PLANNING.GEOCODED' && before.moved) return 'quiet';
  if (code === 'OUTBOUND.PICKUP_FAILED') return before.received ? 'quiet' : { stage: 'exception', source: 'carrier_map' };
  const mapped = jitsuScanStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * What the map says about one scan, by its code alone. A notice moves nothing,
 * and a code whose stage the scans before it decide has none on its own.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && !Object.hasOwn(CONTEXTUAL, code) ? jitsuScanStage(code) : undefined),
  gaps: [...Object.entries(QUIET), ...Object.entries(CONTEXTUAL)].map(([code, note]) => ({ code, note })),
};
