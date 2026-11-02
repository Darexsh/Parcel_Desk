import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import evidence from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(evidence.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function viettelPostStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(wording), gaps: [] };
