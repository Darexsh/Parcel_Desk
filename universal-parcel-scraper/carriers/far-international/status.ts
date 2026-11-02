import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * FAR's scans are its warehouse's and air line's wording in Chinese with an
 * English translation, of which the parser keeps the English, then the
 * last-mile carrier's own wording in English or Chinese. The map is the
 * wording recorded in `statuses.json`; other wording goes to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function farStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker gives no scan codes, so the map reads the wording alone. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(wording),
  gaps: [],
};
