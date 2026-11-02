import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const CODES = new Map<string, Stage>(statuses.entries.flatMap(entry => entry.code ? [[entry.code, entry.stage as Stage] as const] : []));

export function trendyolStage(wording: string): ClassifiedWording | null {
  const stage = STAGES.get(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? STAGES.get(wording), gaps: [] };
