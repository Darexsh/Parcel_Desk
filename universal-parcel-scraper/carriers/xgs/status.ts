import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The API's status codes, as its tracking widget tests them; one it does not list has no stage.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** The stage XGS's map gives a status code. */
export function xgsMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code.toUpperCase());
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => xgsMappedStage(code),
  gaps: [],
};
