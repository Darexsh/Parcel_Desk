import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Line Clear's scan codes, from replies and from the script of its tracking
 * page, which rewords some of them. Another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['WB024', 'registered'], // Awaiting Shipment Handover: the waybill exists; the sender has not handed the parcel over.
  ['WB027', 'accepted'], // Order Picked Up from Station/Platform/Hotspot.
  ['WB002', 'accepted'], // Checked In at Pickup Branch.
  ['WB004', 'in_transit'], // Left the pickup branch for a hub.
  ['WB009', 'in_transit'], // Left the pickup hub.
  ['WB013', 'in_transit'], // Transit Cage Out.
  ['WB030', 'in_transit'], // Left for a station.
  ['WB031', 'in_transit'], // Left for a platform or hotspot.
  ['WB033', 'in_transit'], // Check In at Exchange Hub.
  ['WB044', 'in_transit'], // Manifest Out Scan at Exchange Hub, to the delivering branch.
  ['WB051', 'in_transit'], // Manifest Out Scan Completed.
  // Ready for Delivery, which the page shows as Parcel has Arrived: at the delivering branch, before a rider takes it.
  ['WB017', 'in_transit'],
  ['WB018', 'out_for_delivery'],
  ['WB020', 'failed_attempt'], // Undelivered, with its reason.
  ['WB021', 'delivered'],
]);

/** The stage Line Clear's codes give a scan code. */
export function lineClearMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function lineClearStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = lineClearMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? lineClearMappedStage(code) : undefined),
  gaps: [],
};
