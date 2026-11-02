import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The rows seen, by their `normalizeStatusWording` wording.
const ROWS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage the map gives a row's wording, if it knows it. Wording that starts
 * with RTO, return to origin, is the parcel on its way back to the merchant.
 */
export function shiprocketScanStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return ROWS.get(normalized) ?? (/^rto\b/.test(normalized) ? 'returned' : undefined);
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function shiprocketStage(description: string): ClassifiedWording | null {
  const mapped = shiprocketScanStage(description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : shiprocketScanStage(wording)),
  gaps: [],
};
