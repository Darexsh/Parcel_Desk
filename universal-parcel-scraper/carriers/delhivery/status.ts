import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const statuses: Record<string, ClassifiedStatus> = {
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  'OUT FOR DELIVERY': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'IN TRANSIT': { status: 'in_transit', stage: 'in_transit' },
  'IN TRANSIT FOR RETURN': { status: 'in_transit', stage: 'in_transit' },
  'ON THE WAY': { status: 'in_transit', stage: 'in_transit' },
  // The scan of the out-for-delivery milestone.
  DISPATCHED: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'PICKED UP': { status: 'in_transit', stage: 'accepted' },
  MANIFESTED: { status: 'pending', stage: 'registered' },
  'RTO DELIVERED': { status: 'exception', stage: 'returned' },
  'DELIVERED SELLER': { status: 'exception', stage: 'returned' },
  // Return to origin and a customer return, each scanned on delivery to the seller.
  RTO: { status: 'exception', stage: 'returned' },
  DTO: { status: 'exception', stage: 'returned' },
  LOST: { status: 'exception', stage: 'exception' },
  CANCELLED: { status: 'exception', stage: 'exception' },
  CANCELED: { status: 'exception', stage: 'exception' },
};

// The current status can come as a token ("IN_TRANSIT") rather than words.
export function classifyDelhiveryStatus(value: string): ClassifiedStatus | undefined {
  return statuses[value.toUpperCase().replaceAll('_', ' ')];
}

/**
 * What the map says about one scan: its wording, as the adapter classifies it. A delivery on the
 * return leg reaches the seller, and the stored scan does not keep the leg, so it stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const stage = classifyDelhiveryStatus(wording)?.stage;
    return stage === 'delivered' ? undefined : stage;
  },
  gaps: [{ wording: 'delivered', note: 'Delivered to the recipient, or to the seller when its scan type or the shipment\'s flow is a return: the stored scan does not keep either.' }],
};
