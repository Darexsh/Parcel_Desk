import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string };
const WORDINGS = new Map<string, Stage>((statuses.entries as readonly Entry[])
  .filter(entry => !entry.code && entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stone3plStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export function stone3plScanStage(wording: string): ClassifiedWording | null {
  const mapped = stone3plStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

// A scan's numeric status is a broad bucket: even pre-advice can be 1 (in transit).
// The scan's wording, rather than that bucket, establishes its milestone.
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stone3plStage(wording),
  gaps: [],
};
