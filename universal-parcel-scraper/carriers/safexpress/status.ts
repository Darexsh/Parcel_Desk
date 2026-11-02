import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The booking row says that the waybill was generated, before a physical arrival.
  ['BOOKED', 'registered'],
  ['IN-TRANSIT', 'in_transit'],
  ['ARRIVED AT DESTINATION', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['PARTIALLY DELIVERED', 'in_transit'],
]);

export function safexpressStage(value: string): Stage | undefined {
  return STAGES.get(value.trim().toUpperCase());
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => safexpressStage(code || wording),
  gaps: [],
};
