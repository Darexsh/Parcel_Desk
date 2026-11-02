import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { wording: string; stage?: string };

/**
 * The tracker's wordings, without the place it puts after them: SP Express's
 * own order and hub steps, and the partners' scans it relays, in English or
 * Polish and in any letter case.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly Entry[])
  .filter((entry) => entry.stage).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage the tracker's map gives a wording. */
export function spExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the tracker's map, else the shared wording rules, else nothing. */
export function spExpressStage(wording: string): ClassifiedWording | null {
  const mapped = spExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => spExpressMappedStage(wording),
  gaps: [],
};
