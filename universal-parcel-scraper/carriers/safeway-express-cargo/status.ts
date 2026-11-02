import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The scan the page's shipped day stands for. */
export const SHIPPED = 'Shipped';

/** Safe Way's wordings by their normalized form; a status the map lacks falls to the shared rules. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** A status's or scan's stage: the map, else the shared wording rules, else nothing. */
export function safewayStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(wording), gaps: [] };
