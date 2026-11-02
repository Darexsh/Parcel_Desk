import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The steps of the tracker's progress bar, by number; the legend under it names them.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** The stage ATS Healthcare's map gives a progress step; a step it does not list has none. */
export function atsMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => atsMappedStage(code),
  gaps: [],
};
