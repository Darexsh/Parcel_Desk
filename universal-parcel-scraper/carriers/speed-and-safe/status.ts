import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Gokulam Speed & Safe's statuses, by their wording. Each row also carries a
 * one-letter `transit` code, kept as the provider code: `M` for a dispatch to
 * another branch, `I` for an arrival, `O` for out for delivery and `D` for a
 * delivery. The wording decides, so a code seen with another status falls to
 * the shared wording rules. The page adds the other branch to a dispatch or
 * an arrival, as "Dispatched to …" and "Arrived at …".
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^dispatched\b/i, 'in_transit'],
  [/^arrived\b/i, 'in_transit'],
  [/^out for delivery\b/i, 'out_for_delivery'],
  [/^delivered\b/i, 'delivered'],
];

/** The stage Gokulam Speed & Safe's own wordings give a scan. */
export function speedAndSafeMappedStage(wording: string): Stage | undefined {
  const value = wording.trim();
  return WORDINGS.find(([pattern]) => pattern.test(value))?.[1];
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function speedAndSafeStage(wording: string): ClassifiedWording | null {
  const mapped = speedAndSafeMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => speedAndSafeMappedStage(wording),
  gaps: [],
};
