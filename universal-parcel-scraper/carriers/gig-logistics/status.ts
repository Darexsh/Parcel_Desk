import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * GIG's scans each have a code, such as `OKT`, and the code's fixed wording.
 * The code is the key; a code not recorded in `statuses.json` falls to its
 * recorded wording, then to the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));
const CODE_WORDINGS: ReadonlyMap<string, string> = new Map(ENTRIES.filter((entry) => entry.code && entry.wording)
  .map((entry) => [entry.code!, entry.wording!]));

/** The wording recorded for a scan code. */
export function gigLogisticsCodeWording(code: string): string | undefined {
  return CODE_WORDINGS.get(code);
}

/** A scan's stage: its code, else its wording, else the shared wording rules, else nothing. */
export function gigLogisticsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code) ?? WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan, by its code or its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? WORDINGS.get(wording),
  gaps: [],
};
