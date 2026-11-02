import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Exact English tracking labels from the official Japan Post result table and
// its tracking notices. Provenance is recorded in statuses.json.
const STATUS = new Map<string, ClassifiedStatus>([
  ['Posting/Collection', { status: 'in_transit', stage: 'accepted' }],
  ['En route', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at outward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Dispatch from outward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival at inward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Item presented to import Customs', { status: 'in_transit', stage: 'customs' }],
  ['In Customs', { status: 'in_transit', stage: 'customs' }],
  ['Item held at inward Office of Exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Item returned from import Customs', { status: 'in_transit', stage: 'in_transit' }],
  ['Departure from inward office of exchange', { status: 'in_transit', stage: 'in_transit' }],
  ['Item out of sorting centre', { status: 'in_transit', stage: 'in_transit' }],
  // The destination post's delivery office has the item; like Retention, the
  // label does not say whether the recipient can collect it.
  ['Item held at delivery depot/delivery office', { status: 'in_transit', stage: 'in_transit' }],
  ['Processing at delivery Post Office', { status: 'in_transit', stage: 'in_transit' }],
  ['Item out for physical delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Final delivery', { status: 'delivered', stage: 'delivered' }],
  ['Final delivery - Collected at counter', { status: 'delivered', stage: 'delivered' }],
  // Held at the delivery office: after a missed delivery, for counter
  // collection or until a designated day. The label does not say which.
  ['Retention', { status: 'in_transit', stage: 'in_transit' }],
  // These two say why the item is held: the round missed the addressee.
  ['Office closed. Retention.', { status: 'exception', stage: 'failed_attempt' }],
  ['Absence. Attempted delivery.', { status: 'exception', stage: 'failed_attempt' }],
  ['Held by import Customs', { status: 'in_transit', stage: 'customs' }],
  ['Import stopped', { status: 'exception', stage: 'exception' }],
  ['Item into sorting centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Returned to Sender', { status: 'exception', stage: 'returned' }],
  ['Arrival', { status: 'in_transit', stage: 'in_transit' }],
  ['Dispatched from Exchange Office', { status: 'in_transit', stage: 'in_transit' }],
  ['Transported in bond', { status: 'in_transit', stage: 'customs' }],
  ['Arrived in bond', { status: 'in_transit', stage: 'customs' }],
  ['Returned to sender', { status: 'exception', stage: 'returned' }],
]);

export function japanPostStatus(description: string): ClassifiedStatus | undefined {
  return STATUS.get(description);
}

const STAGE_BY_WORDING = new Map<string, Stage>([...STATUS].map(([label, status]) => [normalizeStatusWording(label), status.stage]));

/** What the map says about one scan: its exact label, as the parser reads it. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STAGE_BY_WORDING.get(wording), gaps: [] };
