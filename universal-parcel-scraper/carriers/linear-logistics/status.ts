import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['label created', 'registered'],
  ['arrived at hub', 'in_transit'],
  ['item received by dx and awaiting route scan', 'in_transit'],
  ['item added to delivery route', 'in_transit'],
  ['item out on delivery vehicle', 'out_for_delivery'],
  ['calling card has been left at the address', 'failed_attempt'],
  ['item has been delivered as requested', 'delivered'],
]);
const REDELIVERY = 'redelivery has been booked';

export function linearMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** The feed has no event codes; the booking notice moves nothing. */
export function linearStage(wording: string): ClassifiedWording | null {
  const mapped = linearMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording) === REDELIVERY) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : linearMappedStage(wording)),
  gaps: [{ wording: REDELIVERY, note: 'A future redelivery has been booked; keep the stage reached by the earlier scans.' }],
};
