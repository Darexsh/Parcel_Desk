import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Tonami's milestones, as the tracker's history rows name them, and its states, as the detail words
// them. The tracker shows no codes, and the shared wording rules read no Japanese, so a wording not
// listed has no stage.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage Tonami's map gives a milestone or a state. */
export function tonamiMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A milestone's or state's stage from the map, else nothing. */
export function tonamiStage(wording: string): ClassifiedWording | null {
  const stage = tonamiMappedStage(wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
};
