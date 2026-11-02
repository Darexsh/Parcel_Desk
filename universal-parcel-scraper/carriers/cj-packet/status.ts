import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** One of a shipment's summary statuses: the tracker's name for it and its stage. */
interface CjPacketSummary {
  readonly wording: string;
  readonly stage: Stage;
  /** A summary that spans several legs: the newest scan says which, when it is no earlier. */
  readonly scansDecide?: boolean;
}

/**
 * The shipment's `status`, as the tracker's tabs name and describe it.
 * Dispatched is the parcel leaving CJ's warehouse with the line; En Route
 * covers the export airport, the flight and the destination's airport;
 * Arrived Courier Facility covers the destination's sorting centre and its
 * customs clearance. Unsuccessful Delivery is a parcel the courier could not
 * deliver for a wrong address or recipient.
 */
const SUMMARIES = new Map<number, CjPacketSummary>([
  [0, { wording: 'Processing', stage: 'registered', scansDecide: true }],
  [1, { wording: 'Dispatched', stage: 'accepted', scansDecide: true }],
  [2, { wording: 'En Route', stage: 'in_transit', scansDecide: true }],
  [3, { wording: 'Arrived Courier Facility', stage: 'in_transit', scansDecide: true }],
  [4, { wording: 'Out for Delivery', stage: 'out_for_delivery' }],
  [5, { wording: 'Available for Pickup', stage: 'ready_for_pickup' }],
  [6, { wording: 'Unsuccessful Delivery', stage: 'exception' }],
  [7, { wording: 'Delivered', stage: 'delivered' }],
]);

export function cjPacketSummary(code: number): CjPacketSummary | undefined {
  return SUMMARIES.get(code);
}

// The stages a summary that spans several legs leaves to the scans, in order.
const LEGS: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'customs'];

/** The shipment's stage: its summary, or the newest staged scan within a summary that spans several legs. */
export function cjPacketCurrentStage(summary: CjPacketSummary | undefined, scanned: Stage | undefined): Stage | undefined {
  if (!summary) return scanned;
  if (summary.scansDecide && scanned && LEGS.indexOf(scanned) >= LEGS.indexOf(summary.stage)) return scanned;
  return summary.stage;
}

/**
 * Scans carry wording only: CJ's own label line, then the lines of the
 * forwarder and of the destination's courier, relayed as each words them.
 * The ones the shared rules leave without a stage are mapped here.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['label created. warehouse is processing this order. please wait in patience.', 'registered'],
  ['shipment info received', 'registered'],
  // The line's pickup at CJ's warehouse.
  ['item has been collected', 'accepted'],
  ['the flight has taken off from its origin', 'in_transit'],
  ['item flight landing', 'in_transit'],
  ['prepared for last mile handover', 'in_transit'],
  ['delivery to local courier', 'in_transit'],
]);

// Notices that move nothing.
const NOTICES = new Set(['expected delivery date updated']);

export function cjPacketMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function cjPacketStage(wording: string): ClassifiedWording | null {
  const mapped = cjPacketMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans carry no code; a summary status is the provider code of a shipment without scans. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? cjPacketMappedStage(wording)
    : /^\d$/.test(code) ? SUMMARIES.get(Number(code))?.stage : undefined,
  gaps: [...NOTICES].map((wording) => ({ wording, note: 'A new delivery estimate from the destination courier; it moves nothing.' })),
};
