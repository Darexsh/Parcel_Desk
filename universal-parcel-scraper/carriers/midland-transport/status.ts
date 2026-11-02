import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's Activity column, the shipping platform's category for each
 * scan, which is also the word over the page's summary and the steps of its
 * progress bar. Midland's own wording, in the Description column, refines it.
 * Only categories seen on the page are mapped; another falls to the wording
 * rules.
 */
const ACTIVITIES: ReadonlyMap<string, Stage> = new Map([
  ['shipment created', 'registered'], // The progress bar's first step, dated when the shipper made the label.
  ['no tracking info', 'registered'], // Shown until Midland scans the parcel.
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['delivery exception', 'exception'], // A delay Midland reports, with its reason: the shipper's or consignee's.
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage the tracker's Activity column gives a scan. */
export function midlandMappedStage(activity: string): Stage | undefined {
  return ACTIVITIES.get(activity.trim().toLowerCase());
}

/** A scan's stage: its Activity, else the shared wording rules, else nothing. */
export function midlandStage(activity: string, wording: string): ClassifiedWording | null {
  const mapped = midlandMappedStage(activity);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? midlandMappedStage(code) : undefined),
  gaps: [],
};
