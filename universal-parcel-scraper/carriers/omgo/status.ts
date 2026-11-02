import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.map(entry =>
  [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export const omgoStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => omgoStage(wording), gaps: [] };
