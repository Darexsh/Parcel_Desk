import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Leopards' wordings, read by how they start: the city after "at" or "in" and
 * a pending delivery's reason vary. The first three come from its older COD
 * tracker.
 */
const ACTIONS: readonly (readonly [RegExp, Stage])[] = [
  [/^posted for consignment booking\b/, 'registered'],
  [/^shipment picked\b/, 'accepted'],
  // Handed to a courier for delivery. The page writes "Leopards" where the courier's name would be.
  [/^assign to courier\b/, 'out_for_delivery'],
  [/^assigned to leopards\b/, 'out_for_delivery'],
  [/^inter transfer\b/, 'in_transit'],
  // The delivery waits, with the reason in capitals, as "Pending WRONG/INCORRECT ADDRESS".
  [/^pending\b/, 'failed_attempt'],
  [/^delivered\b/, 'delivered'],
];

/** The stage a Leopards wording starts with, read case-insensitively. */
export function leopardsWordingStage(wording: string): Stage | undefined {
  const text = wording.toLowerCase().trim().split(/\s+/).join(' ');
  return ACTIONS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function leopardsStage(wording: string): ClassifiedWording | null {
  const mapped = leopardsWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => leopardsWordingStage(wording),
  gaps: [],
};
