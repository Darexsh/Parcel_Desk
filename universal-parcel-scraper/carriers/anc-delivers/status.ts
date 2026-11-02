import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map((statuses.entries as readonly { wording: string; stage: string }[])
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage of a step of ANC's tracking page, by its title. "Delayed" names
 * no place in the journey, so the shared wording rules read it.
 */
export const ancStage = (title: string): Stage | undefined => STAGES.get(normalizeStatusWording(title));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ancStage(wording),
  gaps: [],
};
