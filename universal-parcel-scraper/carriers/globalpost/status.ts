import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of GlobalPost's tracker, which shows no codes on its scans. It
 * relays its partners' scans in the same vocabulary: USPS on the way to
 * GlobalPost's facility and the delivering post or courier abroad. Only
 * wordings seen on the tracker are mapped; another falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Label Created', 'registered'],
  ['Data Received', 'registered'],
  ['Arrived at Partner Facility', 'in_transit'],
  ['Departed Partner Facility', 'in_transit'],
  // GlobalPost's own consolidation facility; a partner's inbound scans can come before it.
  ['Arrived at GlobalPost Facility', 'accepted'],
  ['Departed GlobalPost Facility', 'in_transit'],
  ['Departed from Origin Country', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['In-Transit', 'in_transit'],
  ['Arrived in Destination Country', 'in_transit'],
  ['In Customs', 'customs'],
  ['Cleared Customs', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Attempted Delivery', 'failed_attempt'],
  ['Exception, No Action Required', 'exception'],
  ['Delayed, No Action Required', 'exception'],
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The tracker's reassurance that can follow a scan's wording in the same cell. */
const NOTE = /\s*tracking updates may take time\b.*$/;

/** The stage the map gives a wording, if it knows it, with or without the tracker's note after it. */
export function globalpostMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? WORDINGS.get(key.replace(NOTE, ''));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function globalpostStage(wording: string): ClassifiedWording | null {
  const mapped = globalpostMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => globalpostMappedStage(wording),
  gaps: [],
};
