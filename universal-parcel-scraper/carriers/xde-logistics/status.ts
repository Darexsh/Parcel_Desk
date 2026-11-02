import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * XDE's scans carry no code, only a status name. The names seen in replies are
 * mapped; another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Picked at warehouse', 'accepted'], // A courier collected the parcel from the seller for sorting.
  ['Received at hub', 'in_transit'],
  ['First delivery attempt', 'out_for_delivery'], // The courier is delivering it; a delivery or a failed attempt follows.
  ['Delivery successful', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a status name. */
export function xdeLogisticsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its status name in the map, else the shared wording rules, else nothing. */
export function xdeLogisticsStage(wording: string): ClassifiedWording | null {
  const mapped = xdeLogisticsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => xdeLogisticsMappedStage(wording),
  gaps: [],
};
