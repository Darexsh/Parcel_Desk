import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Exact English event labels from the official GlobalEco international portal.
// Evidence for observed versus synthetic boundaries lives in statuses.json.
const STATUSES: Record<string, ClassifiedStatus> = {
  'created': { status: 'pending', stage: 'registered' },
  'received at evri': { status: 'in_transit', stage: 'accepted' },
  'accepted': { status: 'in_transit', stage: 'accepted' },
  'consolidated': { status: 'in_transit', stage: 'in_transit' },
  'processed at export gateway': { status: 'in_transit', stage: 'in_transit' },
  'cross docked': { status: 'in_transit', stage: 'in_transit' },
  'in transit': { status: 'in_transit', stage: 'in_transit' },
  'in customs': { status: 'in_transit', stage: 'customs' },
  'customs cleared': { status: 'in_transit', stage: 'in_transit' },
  'departed origin country': { status: 'in_transit', stage: 'in_transit' },
  'arrived in country': { status: 'in_transit', stage: 'in_transit' },
  'handed to partner carrier': { status: 'in_transit', stage: 'in_transit' },
  'received by carrier': { status: 'in_transit', stage: 'in_transit' },
  'delayed': { status: 'in_transit', stage: 'in_transit' },
  'at the local depot': { status: 'in_transit', stage: 'in_transit' },
  'delivery attempted': { status: 'exception', stage: 'failed_attempt' },
  'carrier label error': { status: 'exception', stage: 'exception' },
  'delivery exception': { status: 'exception', stage: 'exception' },
  'out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'ready for collection': { status: 'in_transit', stage: 'ready_for_pickup' },
  'delivery awaiting collection': { status: 'in_transit', stage: 'ready_for_pickup' },
  'delivered': { status: 'delivered', stage: 'delivered' },
  'returned to sender': { status: 'exception', stage: 'returned' },
};

export function evriStatus(wording: string): ClassifiedStatus | undefined {
  const key = wording.trim().toLowerCase();
  return Object.hasOwn(STATUSES, key) ? STATUSES[key] : undefined;
}

/** What the map says about one scan: Evri's labels carry no code. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => evriStatus(wording)?.stage, gaps: [] };
