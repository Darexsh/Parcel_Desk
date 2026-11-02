import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Hitch's step names, as its tracking page's timeline and current status word them. The page
// shows no codes.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage Hitch's map gives a step name; one it does not list has none. */
export function hitchMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A step's stage: its name in the map, else the shared wording rules, else nothing. */
export function hitchStage(wording: string): ClassifiedWording | null {
  const mapped = hitchMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
};
