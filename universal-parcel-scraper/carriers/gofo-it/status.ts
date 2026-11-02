import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.filter(entry => entry.stage !== 'failed_attempt').map(entry => [entry.code, entry.stage as Stage]));
const ATTEMPTS = new Set(statuses.entries.filter(entry => entry.stage === 'failed_attempt').map(entry => normalizeStatusWording(entry.wording)));
export function gofoItalyStage(code: string | null, wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (code === '205' && !/^consegnato(?:$|[ ,.!])/.test(normalized)) return undefined;
  if (code === '206' && ATTEMPTS.has(normalized)) return 'failed_attempt';
  return code ? STAGES.get(code) : undefined;
}
export const statusMap: CarrierStatusMap = { stage: gofoItalyStage, gaps: [] };
