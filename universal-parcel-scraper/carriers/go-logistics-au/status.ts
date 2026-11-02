import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The scan wordings of GO Logistics' tracker, which carry no code. Another wording falls to the shared wording rules. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly { wording: string; stage: string }[])
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage GO Logistics' map gives a wording in `normalizeStatusWording` form; one it does not list has none. */
export function goLogisticsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function goLogisticsStage(wording: string): ClassifiedWording | null {
  const mapped = goLogisticsMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => goLogisticsMappedStage(wording),
  gaps: [],
};
