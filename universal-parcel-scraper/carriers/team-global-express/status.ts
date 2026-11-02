import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Scan codes seen in MyTeamGE's histories. The former Toll IPEC network writes
 * a scan type, `$$` and its reason (`1$$9`); the former Toll Priority network a
 * number, with a reason after `$$` on some (`90$$ADP`). Another code falls to
 * the scan's milestone.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1$$0', 'registered'], // The sender's consignment file reached the network.
  ['1$$1', 'accepted'], // Picked up from the sender.
  ['1$$2', 'in_transit'], // Into a depot.
  ['1$$HS', 'in_transit'], // Sorted to the destination.
  ['6$$A00005', 'in_transit'], // Sorted to a chute.
  ['1$$9', 'out_for_delivery'],
  ['1$$8', 'delivered'],
  ['2$$TT', 'failed_attempt'], // Nobody was there to sign.
  ['2$$HC', 'ready_for_pickup'], // Held in the depot for the receiver to collect.
  ['2$$TA', 'in_transit'], // A delay notice; the parcel stays on its way.
  ['0', 'registered'], // The sender's billing record reached the network.
  ['10', 'accepted'], // Picked up from the sender.
  ['11', 'in_transit'], // Linehaul to the destination depot.
  ['14', 'in_transit'], // Into a depot.
  ['18', 'in_transit'], // A depot scan.
  ['19', 'in_transit'], // Processed in a depot.
  ['75', 'out_for_delivery'],
  ['80$$TT', 'failed_attempt'], // Nobody was there to sign.
  ['85$$HP', 'ready_for_pickup'], // An area the drivers do not serve: held for collection.
  ['90', 'delivered'],
  ['90$$ADP', 'ready_for_pickup'], // Left at a service hub for the receiver to collect.
  ['90$$TCP', 'delivered'], // Collected from the service hub.
]);

/**
 * The milestones MyTeamGE files every scan and the shipment under, with the
 * labels its own script gives them. A partial delivery leaves items on their way.
 */
const MILESTONES: ReadonlyMap<string, Stage> = new Map([
  ['SHPCRE', 'registered'], // Shipment created.
  ['PCKDUP', 'accepted'], // Picked up.
  ['INTRNST', 'in_transit'],
  ['OUTFDL', 'out_for_delivery'],
  ['AWTCOL', 'ready_for_pickup'], // Awaiting collection.
  ['PRTDEL', 'in_transit'], // Partially delivered.
  ['DELVERD', 'delivered'],
  ['COLLCTD', 'delivered'], // Collected by the receiver.
  ['CANCLD', 'exception'], // Cancelled.
]);

/** The stage MyTeamGE's codes give a scan code or a milestone. */
export function teamGlobalExpressMappedStage(code: string): Stage | undefined {
  const key = code.trim().toUpperCase();
  return CODES.get(key) ?? MILESTONES.get(key);
}

/** The stage a milestone gives, for the shipment's own status. */
export function teamGlobalExpressMilestoneStage(milestone: string): Stage | undefined {
  return MILESTONES.get(milestone.trim().toUpperCase());
}

// An attempted delivery keeps its in-transit milestone; its exception names it.
const ATTEMPT = /^attempted delivery$/i;

/**
 * A scan's stage: its code, else an attempted delivery its exception names,
 * else its milestone, else the shared wording rules, else nothing.
 */
export function teamGlobalExpressStage(code: string, milestone: string, exception: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code.trim().toUpperCase());
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (ATTEMPT.test(exception.trim())) return { stage: 'failed_attempt', source: 'carrier_map' };
  const filed = teamGlobalExpressMilestoneStage(milestone);
  if (filed) return { stage: filed, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wordings New Zealand's Fast Tracker gives its scans, which carry no code. */
const FAST_TRACKER: ReadonlyMap<string, Stage> = new Map([
  ['BOOKED FOR COLLECTION', 'registered'], // The sender booked a pickup.
  ['GOODS PICKED UP', 'accepted'],
  ['IN TRANSIT', 'in_transit'],
  ['PROCESSING AT DESTINATION BRANCH', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['GOODS DELIVERED', 'delivered'],
]);

/** The stage the map gives a Fast Tracker wording. */
export function fastTrackerMappedStage(wording: string): Stage | undefined {
  return FAST_TRACKER.get(wording.trim().replace(/\s+/g, ' ').toUpperCase());
}

/** A Fast Tracker scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function fastTrackerStage(wording: string): ClassifiedWording | null {
  const mapped = fastTrackerMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // New Zealand's scans come without a code.
  stage: (code, wording) => (code ? teamGlobalExpressMappedStage(code) : fastTrackerMappedStage(wording)),
  gaps: [],
};
