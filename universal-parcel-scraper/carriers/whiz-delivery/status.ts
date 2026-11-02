import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since entries without a stage carry none.
const ENTRIES: readonly { readonly code: string; readonly wording: string; readonly stage?: string; readonly note?: string }[] = statuses.entries;
const STAGES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.stage ? [[entry.code, entry.stage as Stage]] : [])));

/** The stage Whiz Delivery's map gives a status id; an id it does not list has none. */
export function whizMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => whizMappedStage(code),
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => ({ code: entry.code, note: entry.note! })),
};
