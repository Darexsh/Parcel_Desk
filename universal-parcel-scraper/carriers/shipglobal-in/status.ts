import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string };
const ENTRIES = statuses.entries as readonly Entry[];
const WORDINGS = new Map(ENTRIES.filter((entry) => !entry.code && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The guest feed's bag event has its own code; zero on other rows is a placeholder. */
export function shipGlobalMappedStage(code: string | null, wording: string): Stage | undefined {
  return code === 'SGE_207' ? 'in_transit' : WORDINGS.get(normalizeStatusWording(wording));
}

export function shipGlobalStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = shipGlobalMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: shipGlobalMappedStage, gaps: [] };
