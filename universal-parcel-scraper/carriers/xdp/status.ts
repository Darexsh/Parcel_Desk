import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's status types and the stage each gives a consignment. COLLECT
 * is the collection depot taking the parcel from the sender. The app's own
 * labels name DAMAGE, CHECK ADDRESS and SERVICE FAIL as problems.
 */
const TYPES = new Map<string, Stage>([
  ['CREATE', 'registered'],
  ['COLLECT', 'accepted'],
  ['NEXT STOP', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['EXCEPTION', 'exception'],
  ['DAMAGE', 'exception'],
  ['CHECK ADDRESS', 'exception'],
  ['SERVICE FAIL', 'exception'],
]);

/**
 * DELIVERY covers the delivery depot's work, so its wording decides: XDP's
 * own tracking page counts a parcel out for delivery from the scheduled round,
 * and the depot scan and the van allocation before it as being prepared.
 */
function deliveryStage(wording: string): Stage | undefined {
  if (/^scheduled for delivery\b/i.test(wording)) return 'out_for_delivery';
  if (/^(?:at delivery depot|allocated to delivery vehicle\b)/i.test(wording)) return 'in_transit';
  return undefined;
}

/** PRINT, a label printed for the consignment, moves nothing. */
const GAPS = [{ code: 'PRINT', note: 'A label printed for the consignment, with its order or a return; it moves nothing.' }];

/** The stage a status type and its wording give a consignment on its way to the recipient, if any. */
export function xdpStage(type: string, wording: string): Stage | undefined {
  if (type === 'DELIVERY') return deliveryStage(wording);
  return TYPES.get(type);
}

/**
 * After a return label, the adapter files every later scan as the return leg;
 * the map answers for a parcel on its way to the recipient.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? xdpStage(code, wording) : undefined),
  gaps: GAPS,
};
