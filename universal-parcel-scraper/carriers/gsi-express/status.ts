import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The milestones the tracker shows as fields, named by the field's label
 * without its 시간 ("time") or 일 ("date"). Its flights and the domestic
 * carrier's scans are not read.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['출고', 'in_transit'], // The parcel left GSI Express's warehouse in the United States for its flight.
  ['통관완료', 'in_transit'], // Korean customs cleared the parcel, which goes on to the delivery carrier.
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a milestone. */
export function gsiExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A milestone's stage: the map's, else the shared wording rules', else nothing. */
export function gsiExpressStage(wording: string): ClassifiedWording | null {
  const mapped = gsiExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => gsiExpressMappedStage(wording),
  gaps: [],
};
