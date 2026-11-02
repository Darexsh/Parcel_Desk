import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STATUS = new Map<string, ClassifiedStatus>([
  ['Pickup Awaited', { status: 'pending', stage: 'registered' }],
  ['Pickup Scheduled', { status: 'pending', stage: 'registered' }],
  ['Booked', { status: 'pending', stage: 'registered' }],
  ['Booked at Origin Branch', { status: 'pending', stage: 'registered' }],
  ['Picked Up', { status: 'in_transit', stage: 'accepted' }],
  ['Pickup Completed', { status: 'in_transit', stage: 'accepted' }],
  ['In Transit', { status: 'in_transit', stage: 'in_transit' }],
  ['Out For Delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Delivered', { status: 'delivered', stage: 'delivered' }],
  ['RTO Booked', { status: 'exception', stage: 'exception' }],
]);

export function dtdcStatus(wording: string): ClassifiedStatus | undefined {
  return STATUS.get(wording);
}

const STAGE_BY_WORDING = new Map<string, Stage>([...STATUS].map(([label, status]) => [normalizeStatusWording(label), status.stage]));
const DELIVERED = normalizeStatusWording('Delivered');

/**
 * What the map says about one scan: its wording, when that is one of the status labels the
 * parser reads. The scan's own label, which the parser reads first, is not stored; a scan worded
 * with a label carries the same step in it. A delivery is a return on the return leg, which the
 * map is not asked by.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => (wording === DELIVERED ? undefined : STAGE_BY_WORDING.get(wording)),
  gaps: [{ wording: DELIVERED, note: "Delivered on the forward leg, or returned to the sender on the return leg: the map is not asked by the scan's leg." }],
};
