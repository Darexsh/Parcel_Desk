import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** A wording as the map keys it: normalized, without the delivery type the delivered scan names or a closing full stop. */
const key = (wording: string) => normalizeStatusWording(wording).replace(/\s*the delivery type is [^.]*\.?$/u, '').replace(/[\s.。]+$/u, '');

/**
 * The tracker's scans carry no code, only a sentence. Those seen in replies are
 * mapped; other wording falls to the shared rules.
 */
const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [key(entry.wording), entry.stage as Stage]));

/** The stage the map gives a scan's wording. */
export function jAndTDeMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function jAndTDeStage(wording: string): ClassifiedWording | null {
  const mapped = jAndTDeMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jAndTDeMappedStage(wording),
  gaps: [],
};
