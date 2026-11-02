import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Manifested', 'registered'],
  ['Your parcel information has been received', 'registered'],
  ['Your parcel has been picked up', 'accepted'],
  ['Our courier has picked up your parcel from the sender', 'accepted'],
  ['Received and ready for processing', 'in_transit'],
  ['Your Parcel has been processed at facilty', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['Your parcel is on its way to destination depot', 'in_transit'],
  ['Import Customs Clearance Success', 'in_transit'],
  ['Import Customs Handover', 'in_transit'],
  ['Onboard', 'out_for_delivery'],
  ['Our driver has your parcel onboard for delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Your parcel has been left at a safe place (ATL)', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The page's scan wording, including the depot name in an arrival. */
export function pflogisticsMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  if (/^your parcel has arrived at .{1,100} depot$/.test(key)) return 'in_transit';
  return WORDINGS.get(key);
}

/**
 * The detail distinguishes pickup from depot handling under the same broad
 * heading. Customs handover follows successful clearance in PFL's history.
 */
export function pflogisticsStage(heading: string, detail: string): ClassifiedWording | null {
  const mapped = pflogisticsMappedStage(detail || heading);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(detail || heading);
  if (worded.source !== 'none') return worded;
  const category = pflogisticsMappedStage(heading);
  return category ? { stage: category, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : pflogisticsMappedStage(wording),
  gaps: [],
};
