import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string; note?: string };
const ENTRIES = statuses.entries as readonly Entry[];

/** The scan wordings seen on Equick's trackers, in `normalizeStatusWording` form. */
const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => !entry.code && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// A depot, hub, operation centre or airport named by its three-letter code, which changes with the route.
const SITE_SCAN = /^(?:arrived at|departed from) [a-z]{3} (?:depot|hub|operation center|airport)$/;

/** The stage Equick's map gives a scan's wording. */
export function equickStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (SITE_SCAN.test(key) ? 'in_transit' : undefined);
}

/** A scan's stage: Equick's map, else the shared wording rules, else none. */
export function equickScanStage(wording: string): ClassifiedWording | null {
  const mapped = equickStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * Scans come without a code. The tracker's Status column (`In progress`,
 * `Hold`) is not kept: it sets no stage, the wording does.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? equickStage(wording) : undefined),
  gaps: [],
};
