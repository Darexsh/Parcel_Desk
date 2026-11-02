import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The lines of Paperfly's history carry no code, only wording, which the
 * tracking page's script translates by its start. A line can go on after its
 * wording: the hold's reason, or the rider before the adapter takes them out.
 */
const LINES: readonly (readonly [RegExp, Stage])[] = [
  [/^pickup request sent\b/, 'registered'], // The merchant asked for a pickup; Paperfly does not have the parcel yet.
  [/^parcel picked\b/, 'accepted'],
  [/^parcel in transit\b/, 'in_transit'],
  [/^on the way to point\b/, 'in_transit'], // On its way to the delivery point.
  [/^reached (?:at )?delivery point\b/, 'in_transit'],
  [/^on the way to delivery\b/, 'out_for_delivery'],
  // A delivery run that did not deliver; the reason, in Bengali, says why.
  [/^on hold\b/, 'failed_attempt'],
  [/^partially delivered\b/, 'delivered'], // The recipient kept part of the order; the rest goes back.
  [/^delivered\b/, 'delivered'],
  [/^returned to merchant\b/, 'returned'],
  [/^returned\b/, 'returned'],
];

/**
 * The order's own status over the history, which the page shows beside the
 * order number. A history can lose its lines once the order is closed, so
 * the status can be ahead of every line.
 */
const SUMMARY: ReadonlyMap<string, Stage> = new Map(([
  ['Not yet picked', 'registered'],
  ['Pickup request sent', 'registered'],
  ['Picked', 'accepted'],
  ['In transit', 'in_transit'],
  ['On the way to point', 'in_transit'],
  ['Reached at delivery point', 'in_transit'],
  ['On the way to delivery', 'out_for_delivery'],
  ['On hold', 'failed_attempt'],
  ['Delivered', 'delivered'],
  ['Partially delivered', 'delivered'],
  ['Returned', 'returned'],
  ['Returned to merchant', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// Billing the merchant after the delivery is no step of the parcel's.
const INVOICED = /^invoiced\b/;

/** The stage the map gives a history line's wording. */
export function paperflyMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return LINES.find(([line]) => line.test(key))?.[1];
}

/** The stage of the order's own status, or undefined for one the map does not know. */
export function paperflySummaryStage(status: string): Stage | undefined {
  return SUMMARY.get(normalizeStatusWording(status));
}

/** A line's stage: its wording in the map, else the shared wording rules, else nothing. */
export function paperflyStage(wording: string): ClassifiedWording | null {
  const mapped = paperflyMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (INVOICED.test(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => paperflyMappedStage(wording),
  gaps: [
    { wording: 'invoiced', note: 'Paperfly billed the merchant after the delivery; the parcel does not move.' },
  ],
};
