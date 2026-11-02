import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * YDH's scans carry a code when YDH or its partner abroad files a milestone,
 * whatever the wording: YDH's own in Chinese or English, or the partner's
 * relayed in its language. Scans without a code are YDH's warehouse and
 * export steps, or the partner's, in their wording. The map is the codes and
 * wording recorded in `statuses.json`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** The codes that name no one milestone: the partner's wording does. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped && entry.code).map((entry) => ({ code: entry.code!, note: entry.note ?? '' }));

/** A scan's stage: its code, else its wording in the map, else the shared wording rules, else nothing. */
export function ydhStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = code ? CODES.get(code) : WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan, by its code, or by its wording when it has none. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: GAPS,
};
