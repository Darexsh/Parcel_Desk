import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));
export function gofoNetherlandsStage(code: string | null, wording: string): Stage | undefined {
  if (code === '205' && !/^bezorgd(?:$|[ ,.!])/.test(normalizeStatusWording(wording))) return undefined;
  return code ? STAGES.get(code) : undefined;
}
export const statusMap: CarrierStatusMap = { stage: gofoNetherlandsStage, gaps: [] };
