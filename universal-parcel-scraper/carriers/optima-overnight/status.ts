import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since entries without a stage carry none.
const ENTRIES: readonly { readonly wording: string; readonly stage?: string; readonly note?: string }[] = statuses.entries;
const STAGES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage]] : [])));

/** The stage Optima's map gives a status, as its tracking page words it; one it does not list has none. */
export function optimaMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
};
