import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * UKP Worldwide's own rows, by wording. A row's code is kept, but one code
 * groups several wordings (48 for US customs' notices), so only the wording
 * decides. Rows it relays from USPS fall to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The rows come with their code, which the app's lookup of a gap matches too.
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ ...(entry.code ? { code: entry.code } : {}), wording: normalizeStatusWording(entry.wording), note: entry.note }));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function ukpStage(wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(key);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.some((gap) => gap.wording === key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(wording), gaps: GAPS };
