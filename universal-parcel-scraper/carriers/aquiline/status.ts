import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The scans are Amazon's English wording without codes; the shared rules read most of them. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const GAPS = ENTRIES.filter((entry) => entry.unmapped).map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note }));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function aquilineStage(wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(key);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.some((gap) => gap.wording === key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)), gaps: GAPS };
