import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * YYpost's scans are English wording from its warehouse in Shenzhen, its air
 * line through Hong Kong and the destination's clearance. The map is the
 * wording recorded in `statuses.json`; other wording goes to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function yypostStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans carry no code the adapter reads; the map reads the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)),
  gaps: [],
};
