import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Vimenpaq's status wordings, which its staff pick on ControlBox. The rows
 * carry no codes. Only wording seen in replies is mapped; other wording falls
 * to the shared rules.
 */
const WORDINGS = new Map<string, Stage>((statuses.entries as { wording: string; stage: string }[])
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage the map gives a wording, if it knows it. */
export function vimenpaqMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A wording's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function vimenpaqStage(wording: string): ClassifiedWording | null {
  const mapped = vimenpaqMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : vimenpaqMappedStage(wording)),
  gaps: [],
};
