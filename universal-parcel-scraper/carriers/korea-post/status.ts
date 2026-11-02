import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDING = new Map<string, ClassifiedStatus>([
  ['Posting/Collection', { status: 'in_transit', stage: 'accepted' }],
  ['Departure from inward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at Office of Exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at outward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Ready for dispatch', { status: 'in_transit', stage: 'in_transit' }],
  ['Handed over to a transport company', { status: 'in_transit', stage: 'in_transit' }],
  ['Received by Air carriers', { status: 'in_transit', stage: 'in_transit' }],
  ['Departure from the Airport', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at Destination Airport', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivered to Destination Post', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at inward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Ready for customs clearance', { status: 'in_transit', stage: 'customs' }],
  ['Unsuccessful delivery', { status: 'exception', stage: 'failed_attempt' }],
  ['Delivery complete', { status: 'delivered', stage: 'delivered' }],
  // Domestic wording.
  ['운송장출력', { status: 'pending', stage: 'registered' }],
  ['집하완료', { status: 'in_transit', stage: 'accepted' }],
  ['인수완료', { status: 'in_transit', stage: 'accepted' }],
  ['접수', { status: 'in_transit', stage: 'accepted' }],
  ['발송', { status: 'in_transit', stage: 'in_transit' }],
  ['도착', { status: 'in_transit', stage: 'in_transit' }],
  ['배달준비', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['배달완료', { status: 'delivered', stage: 'delivered' }],
]);

export function koreaPostStatus(description: string): ClassifiedStatus | undefined {
  return WORDING.get(description);
}

const STAGE_BY_WORDING = new Map<string, Stage>([...WORDING].map(([label, status]) => [normalizeStatusWording(label), status.stage]));

/** What the map says about one scan: its exact label, as the adapter reads it. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STAGE_BY_WORDING.get(wording), gaps: [] };
