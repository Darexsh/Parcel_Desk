import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Komon files each milestone with a code of its own, whatever the wording:
 * its steps in China in its English, and the delivering network's in that
 * network's. The map is the codes recorded in `statuses.json`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [entry.code, entry.stage as Stage]));

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function komonStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan, by its code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code) : undefined),
  gaps: [],
};
