import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

export const jntCargoStage = (code: string): Stage | undefined => STAGES.get(code);
export const statusMap: CarrierStatusMap = { stage: code => code ? jntCargoStage(code) : undefined, gaps: [] };
