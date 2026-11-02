import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event codes of Followmont's freight system, TruckMate, in upper case as
 * the Track & Trace page compares them. Each item of a consignment gets its
 * own scans. Only codes seen in replies, or that the page's script names with
 * the status it shows, are mapped; another falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PICKUP', 'accepted'],
  // A hub's scanning tunnel; the page shows In-Transit.
  ['TUNNEL', 'in_transit'],
  ['DEPOTIN', 'in_transit'],
  ['INTRANSIT', 'in_transit'],
  ['UNLOAD', 'in_transit'],
  // Loaded onto a linehaul: "In-Transit to next facility".
  ['LHLOAD', 'in_transit'],
  // Handed to an on-forwarding agent; the page shows In-Transit.
  ['ON-FORWARD', 'in_transit'],
  // The page shows At Delivery Depot.
  ['DEPOTIN-DESTINATION DEPOT', 'in_transit'],
  ['ONDELIVERY', 'out_for_delivery'],
  // The page shows Out For Delivery for it, as for ONDELIVERY.
  ['MANIFEST', 'out_for_delivery'],
  ['DPTCOLLECT', 'ready_for_pickup'],
  ['DELIVERY', 'delivered'],
  ['POD', 'delivered'],
]);

/**
 * The statuses the Track & Trace page shows for a consignment, which it
 * derives from the newest event; they come without a code.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording('Shipment Info Received'), 'registered'],
  [normalizeStatusWording('Picked Up'), 'accepted'],
  [normalizeStatusWording('In-Transit'), 'in_transit'],
  [normalizeStatusWording('In-Transit to next facility'), 'in_transit'],
  [normalizeStatusWording('At Delivery Depot'), 'in_transit'],
  [normalizeStatusWording('Out For Delivery'), 'out_for_delivery'],
  [normalizeStatusWording('Ready for Collection'), 'ready_for_pickup'],
  [normalizeStatusWording('Delivered'), 'delivered'],
]);

// The consignment's own record in the system, which the page leaves out when it picks the newest event.
const BOOKKEEPING: ReadonlySet<string> = new Set(['ADDED', 'SHIPPER']);

/** Whether an event code only records the consignment in the system. */
export function isFollowmontBookkeeping(code: string): boolean {
  return BOOKKEEPING.has(code.toUpperCase());
}

/** The stage Followmont's codes give an event code. */
export function followmontMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** An event's stage: its code, else the shared wording rules, else nothing. */
export function followmontStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = followmontMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isFollowmontBookkeeping(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? WORDINGS.get(wording) : followmontMappedStage(code)),
  gaps: [
    { code: 'ADDED', note: 'The consignment added to the freight system; the Track & Trace page skips it when it picks the newest event.' },
    { code: 'SHIPPER', note: 'The shipper\'s own record of the consignment; the Track & Trace page skips it when it picks the newest event.' },
  ],
};
