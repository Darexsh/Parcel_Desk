import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Sendle's tracker gives a parcel's status as a category code
 * (`statusCategory`) and its scans as English wording without codes. The map
 * is the codes and wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));

/** The statuses that name no milestone. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped && entry.code).map((entry) => ({ code: entry.code!, note: entry.note ?? '' }));

/** The stage of a parcel's status category. */
export function sendleCategoryStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The shared rules' stage for some wording, or null. */
function worded(text: string): ClassifiedWording | null {
  const classified = text ? classifyWording(text, 'in_transit') : null;
  return classified && classified.source !== 'none' ? classified : null;
}

/**
 * A scan's stage: the map, else the shared wording rules. A scan that says no
 * more than that the parcel moves takes the stage of the page's line under it,
 * which the page reads for a pickup or a delivery round.
 */
export function sendleStage(wording: string, detail = ''): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  const staged = mapped ? { stage: mapped, source: 'carrier_map' } : worded(wording);
  if (staged && staged.stage !== 'in_transit') return staged;
  const detailed = worded(detail);
  return detailed && detailed.stage !== 'in_transit' ? detailed : staged;
}

/** What the map says about a parcel's status, by its code, or about a scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: GAPS,
};
