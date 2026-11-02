import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The Hong Kong waybill service's wording, then the shared wording rules. */
export function taqbinHkStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The service exposes status wording without a scan code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)),
  gaps: [],
};
