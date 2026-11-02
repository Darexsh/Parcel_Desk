import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording: string; readonly stage?: string; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const key = (code: string, wording: string) => `${code} ${normalizeStatusWording(wording)}`;
/** Each row's code with its English wording: Aras Cargo's rows share codes across wordings. */
const STAGES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function weWorldStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = STAGES.get(key(code, wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? STAGES.get(`${code} ${wording}`) : undefined), gaps: [] };
