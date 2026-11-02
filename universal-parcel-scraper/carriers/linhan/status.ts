import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// The next processing center's town sits inside this wording, and the one left in the other.
const TRANSPORT_TO = /^(leave the processing center and transport to) .+ (processing center)$/;
const LEAVE = /^(leave the) (?!processing center\b).+ (processing center)$/;

/** A wording as the map keys it: its `normalizeStatusWording` form, with a processing center's town as "…". */
export function linhanStatusKey(wording: string): string {
  return normalizeStatusWording(wording).replace(TRANSPORT_TO, '$1 … $2').replace(LEAVE, '$1 … $2');
}

/**
 * LinHan's scans are English wording without codes: its own steps in China,
 * then the destination agent's and network's. The summary's status is
 * Chinese. The map is the wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [linhanStatusKey(entry.wording), entry.stage as Stage]));

/** The tracker's status for a number it does not know: never a scan. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

/** The tracker's summary status for a number it does not know, in Chinese and in English. */
export const LINHAN_NOT_FOUND: readonly string[] = ['查询不到', 'Not Found'];

/** The stage LinHan's map gives a scan's wording or the summary's status. */
export function linhanMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(linhanStatusKey(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. A recorded gap has none. */
export function linhanStage(wording: string): ClassifiedWording | null {
  if (GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const mapped = linhanMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan or summary, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : WORDINGS.get(linhanStatusKey(wording))),
  gaps: GAPS,
};
