import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The labels J&T Express Middle East heads its scans with, in English. Only
 * labels seen in replies are mapped; another label falls to the wording rules.
 * A scan's `statusCode` is kept as its provider code but stages nothing: the
 * page reads it only to pick an icon.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['order creation', 'registered'], // The sender created the order; J&T has not collected the parcel yet.
]);

/** The stage J&T Express Middle East's labels give a scan. */
export function jAndTMiddleEastMappedStage(label: string): Stage | undefined {
  return LABELS.get(normalizeStatusWording(label));
}

/** A scan's stage: its label, else the shared wording rules, else nothing. */
export function jAndTMiddleEastStage(label: string): ClassifiedWording | null {
  const mapped = jAndTMiddleEastMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jAndTMiddleEastMappedStage(wording),
  gaps: [],
};
