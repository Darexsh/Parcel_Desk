import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * DayOne's scans are the network's English wording without codes: Yanwen's
 * steps in China, then the destination post's. A parcel's summary status is
 * a code. The map is the wording and codes recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));

/** The summary statuses that name no milestone. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped && entry.code).map((entry) => ({ code: entry.code!, note: entry.note ?? '' }));

/** The stage of a parcel's summary status. */
export function dayoneCodeStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function dayoneStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a summary status, by its code, or about a scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: GAPS,
};
