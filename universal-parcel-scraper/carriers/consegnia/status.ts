import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The statuses Consegnia's tracker shows, as it words them. The adapter writes a
// failed delivery's reason after its status and a colon.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage Consegnia's map gives a status, with or without the reason after it; one it does not list has none. */
export function consegniaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return STAGES.get(key) ?? STAGES.get(key.split(': ', 1)[0]!);
}

/** A status's stage from the map, else from the shared English wording rules, else nothing. */
export function consegniaStage(status: string): ClassifiedWording | null {
  const mapped = consegniaMappedStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(status);
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => consegniaMappedStage(wording),
  gaps: [],
};
