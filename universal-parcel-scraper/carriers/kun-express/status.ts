import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage Kun Express's map gives one of its own rows, by its `normalizeStatusWording`
 * wording. The rows it copies from USPS are left to the shared wording rules.
 */
export function kunExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

export const statusMap: CarrierStatusMap = { stage: kunExpressStage, gaps: [] };
