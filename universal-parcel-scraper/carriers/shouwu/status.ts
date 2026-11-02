import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Shouwu's tracker gives a parcel's status as one of four codes
 * (`traceStatus`), which its page labels, and its scans as wording without
 * codes. A code's wording is the page's label for it, not a scan's; scan
 * wording recorded without a code is the map's, and the rest falls to the
 * shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const LABELS: ReadonlyMap<string, string> = new Map(ENTRIES.filter((entry) => entry.code && entry.wording)
  .map((entry) => [entry.code!, entry.wording!]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** The stage of a parcel's status code. */
export function shouwuStatusStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The page's label for a parcel's status code. */
export function shouwuStatusLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function shouwuStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a parcel's status, by its code, or about a scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: [],
};
