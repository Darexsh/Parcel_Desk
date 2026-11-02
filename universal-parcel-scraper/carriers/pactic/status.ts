import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since entries without a stage carry none.
const ENTRIES: readonly { readonly code: string; readonly wording: string; readonly stage?: string; readonly note?: string }[] = statuses.entries;
const STAGES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.stage ? [[entry.code, entry.stage as Stage]] : [])));
const WORDINGS = new Map<string, string>(ENTRIES.map((entry) => [entry.code, entry.wording]));

/** The stage Pactic's map gives a status code; statuses that move nothing have none. */
export function pacticMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code);
}

/** The English title the tracking page shows for a status code, else the code by its number. */
export function pacticWording(code: string): string {
  return WORDINGS.get(code) ?? `Status ${code}`;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => pacticMappedStage(code),
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => ({ code: entry.code, note: entry.note! })),
};
