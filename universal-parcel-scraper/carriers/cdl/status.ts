import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The wording of the scan that completes a delivery. */
export const DELIVERY_COMPLETE = 'Delivery complete';

/**
 * The scan wordings CDL's tracking service sends, whole, in
 * `normalizeStatusWording` form. They carry no code. A parcel the shipper has
 * not handed over yet is still only registered, although CDL flags the wait
 * as a delay. The scan at the door comes before the delivery is completed.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['label has been created', 'registered'],
  ['awaiting package from shipper', 'registered'],
  ['cdl origin scan', 'accepted'],
  ['cdl transfer scan', 'in_transit'],
  ['package scanned at local delivery center', 'in_transit'],
  ['package out for delivery', 'out_for_delivery'],
  ['package scanned at delivery', 'out_for_delivery'],
  [normalizeStatusWording(DELIVERY_COMPLETE), 'delivered'],
  ['delayed- wrong address', 'exception'],
  ['order under investigation', 'exception'],
]);

// What the shared rules may call a scan CDL flags as an exception.
const PROBLEMS: ReadonlySet<Stage> = new Set(['failed_attempt', 'returned', 'exception']);

/** The stage the map gives a scan's wording, if it knows it. */
export function cdlScanStage(wording: string): Stage | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map. Other wording CDL flags as an exception is a
 * problem: a failed attempt or a return when the shared rules say so, else an
 * exception. Unflagged wording goes to the shared rules, and wording they do
 * not know stays without a stage.
 */
export function cdlStage(wording: string, flagged: boolean): ClassifiedWording | null {
  const mapped = cdlScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (flagged) return worded.source !== 'none' && PROBLEMS.has(worded.stage) ? worded : { stage: 'exception', source: 'carrier_map' };
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only; the exception flag beside other wording is not part of the key. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : cdlScanStage(wording)),
  gaps: [],
};
