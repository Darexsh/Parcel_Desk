import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SFC's own English wording for a scan, without the partner's text it puts
 * in brackets after it. The first lines are SFC's legs in China and the
 * flight; the rest are SFC's names for the destination partner's scans.
 * Only wording seen in replies is mapped; other wording falls to the shared
 * rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The shop's label data; SFC does not have the parcel yet.
  ['shipment information sent to sfc', 'registered'],
  ['sfc driver pick-up', 'accepted'],
  ['arrived at sfc warehouse', 'accepted'],
  ['departured from sfc warehouse', 'in_transit'],
  ['in transit to the international airport to abroad', 'in_transit'],
  ['cargo have been handed over to line-haul', 'in_transit'],
  ['arrive at international airport', 'in_transit'],
  ['flight departure from international airport to abroad', 'in_transit'],
  ['arrived at destination airport', 'in_transit'],
  // Export clearance in China, after the parcel left SFC's warehouse.
  ['shipment started the customs clearance process at origin', 'customs'],
  ['start import customs clearance', 'customs'],
  ['collected from airport terminal', 'in_transit'],
  ['shipment ready for onward transportation to local delivery hub', 'in_transit'],
  ['released by customs', 'in_transit'],
  ['shipment handed over to local ground transport for delivery hub transfer', 'in_transit'],
  // The hand-over to the courier that delivers it, in SFC's spelling.
  ['transfered to local courier', 'in_transit'],
  // The partner's first scan of the parcel; the shared rules read nothing in it.
  ['local courier warehouse, received and ready for processing', 'in_transit'],
  // The courier's regional distribution centre, which names no place.
  ['arrived at rdc centre', 'in_transit'],
  ['in transit', 'in_transit'],
  ['processing at facility', 'in_transit'],
  ['item out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

// Written as the parcel leaves SFC's warehouse, naming the courier that
// delivers it and that courier's number.
const HANDOVER = /^last mile courier\s*=>/;

/** SFC's delivery notice, written as the parcel leaves its warehouse: it names no step of its own. */
export const NOTICE = 'delivery notice';

/** The departure or arrival SFC expects for the flight, written before it: no scan, so the adapter drops it. */
export const ESTIMATE = /^estimated time of international flight (?:departure|arrival)\b/i;

/** The stage SFC's map gives a scan's wording. */
export function sfcMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (HANDOVER.test(key) ? 'in_transit' : undefined);
}

/** A scan's stage: SFC's own wording, else the shared rules, else nothing. */
export function sfcStage(wording: string): ClassifiedWording | null {
  const mapped = sfcMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The order's `track_status`, which the page sorts into its status tabs.
 * Only an end or a wait for collection is taken over the scans: 1 (in
 * transit) is also the page's default, 2 is a long transit, and 6 and 7
 * (received, departed) the scans already tell.
 */
const SUMMARY: ReadonlyMap<number, Stage> = new Map([
  [3, 'delivered'],
  [4, 'returned'],
  [5, 'ready_for_pickup'],
]);

export function sfcSummaryStage(code: unknown): Stage | undefined {
  return typeof code === 'number' ? SUMMARY.get(code) : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => sfcMappedStage(wording),
  gaps: [{
    wording: 'estimated time of international flight departure',
    note: 'The departure SFC expects for the flight, written before it: no scan, so the adapter drops the row.',
  }, {
    wording: 'estimated time of international flight arrival',
    note: 'The arrival SFC expects for the flight, dated at that arrival before it: no scan, so the adapter drops the row.',
  }, {
    wording: NOTICE,
    note: "Written at the same instant as the departure from SFC's warehouse: it names no step of its own.",
  }],
};
