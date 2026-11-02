import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since entries can be unmapped.
export const ENTRIES: readonly { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note: string }[] = statuses.entries;
const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage Wiio's map gives a row, by its `normalizeStatusWording` wording.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function wiioStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

export const statusMap: CarrierStatusMap = {
  stage: wiioStage,
  gaps: ENTRIES.filter((entry) => entry.unmapped).map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note })),
};
