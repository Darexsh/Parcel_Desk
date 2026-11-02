import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** ParcelABC's own statuses, the fixed list its page explains, by their label. */
const LABELS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** A row's stage by its status label: the map, else the shared wording rules, else nothing. */
export function parcelAbcStage(label: string): ClassifiedWording | null {
  const mapped = LABELS.get(normalizeStatusWording(label));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** A scan's description is its status label, then the row's comment after a colon, so the map reads the label before it. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => LABELS.get(wording) ?? LABELS.get(wording.split(': ', 1)[0]!),
  gaps: [],
};
