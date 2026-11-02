import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status badge of a delivery job, in `normalizeStatusWording` form. The
 * badge is the network's own status, untranslated whatever the page's
 * language. A completed job is live evidence; the others are the portal
 * statuses Palletways' FAQ lists. Another badge falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['at collection depot', 'accepted'],
  ['at hub', 'in_transit'],
  ['at delivery depot', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['job complete', 'delivered'],
]);

/** The stage Palletways' map gives a delivery job's badge. */
export function palletwaysMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A delivery job's stage: its badge, else the shared wording rules, else nothing. */
export function palletwaysStage(wording: string): ClassifiedWording | null {
  const mapped = palletwaysMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(wording),
  gaps: [],
};
