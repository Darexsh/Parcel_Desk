import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { imileMappedStage } from '../imile/status.js';

const STAGES: Readonly<Record<string, Stage>> = {
  DataReceived: 'registered', SupplierDataReceived: 'registered', OriginalWarehouseReceive: 'accepted',
  OriginalWarehouseProcess: 'in_transit', OriginalWarehouseDeparture: 'in_transit',
  LinehaulAgencyReceive: 'in_transit', LinehaulAgencyDeparture: 'in_transit', LinehaulDeparture: 'in_transit',
  LinehaulArrival: 'in_transit', CustomsCleared: 'in_transit', SupplierAndLastMileReceive: 'in_transit',
  LastMileInTransit: 'in_transit', LastMileOutForDelivery: 'out_for_delivery', LastMileDeliveryReady: 'out_for_delivery',
  LastMileDelivered: 'delivered',
};

// A US last-mile partner's scans between its receipt and the delivery run, relayed without a code,
// by `normalizeStatusWording` wording.
const UNCODED: ReadonlyMap<string, Stage> = new Map([
  ['in processing at transit facility.', 'in_transit'],
  ['in transit to next facility.', 'in_transit'],
]);

/**
 * A scan's stage by its code, else by the partners' sentences: the tracker relays the last-mile
 * partner's scans in the partner's words, iMile's on a parcel to Germany, most without a code.
 * Null marks a scan that moves nothing.
 */
export function wanbStage(code: string | null, wording: string): Stage | null | undefined {
  if (code && Object.hasOwn(STAGES, code)) return STAGES[code];
  return (code ? undefined : UNCODED.get(normalizeStatusWording(wording))) ?? imileMappedStage('', wording);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => wanbStage(code, wording) ?? undefined, gaps: [],
  gapNote: (code, wording) => (wanbStage(code, wording) === null
    ? 'A line that moves nothing, such as a booked flight or delivery day: the parcel keeps the stage it had.' : undefined),
};
