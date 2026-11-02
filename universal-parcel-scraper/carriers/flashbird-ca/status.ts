import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The rows of FlashBird's tracking history: its own English wording, without a
 * code. The tracking page translates the rows it knows and shows any other as
 * it comes, so another wording falls to the shared rules.
 */
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage FlashBird's own wording gives a row, if the map knows it. */
export function flashbirdMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function flashbirdStage(wording: string): ClassifiedWording | null {
  const mapped = flashbirdMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows come without a code, and every wording seen moves the parcel. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? flashbirdMappedStage(wording) : undefined),
  gaps: [],
};
