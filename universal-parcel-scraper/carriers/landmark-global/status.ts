import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS = new Map<string, ClassifiedStatus>([
  ['Delivered', { status: 'delivered', stage: 'delivered' }],
  ['Delivered - Delivery / deposit with non-recurring authority', { status: 'delivered', stage: 'delivered' }],
  ['Delivered to your community mailbox, parcel locker or apt./condo mailbox', { status: 'delivered', stage: 'delivered' }],
  ...['Onboard for delivery', 'Item out for delivery', 'Out for Delivery'].map(wording => [wording, { status: 'out_for_delivery', stage: 'out_for_delivery' }] as [string, ClassifiedStatus]),
  ['Shipment Data Uploaded', { status: 'pending', stage: 'registered' }],
  ['Item arrival at collection point for pick-up', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Transmitted customs information', { status: 'in_transit', stage: 'customs' }],
  ...['Customs cleared', 'Item processed at facility', 'Item processed', 'Received in destination country',
    'Crossing border and in transit to carrier hub', 'Scanned at Landmark crossdock facility', 'Processed',
    'Shipment received at originating postal facility', 'Departure to country of destination', 'Shipment has arrived at depot',
    'Received at international processing center', 'Incoming scan at facility', 'Shipment has departed from airport',
    'Shipment has departed from depot',
    // A delivery partner's hub after Landmark's export, not the parcel's acceptance.
    'Parcel received at HUB', 'Received at Hermes hub',
    // Evri's depot handing the parcel to its courier, who confirms receipt before delivering.
    'Out For Delivery To Courier',
    // The hand-over to the destination's postal operator for the last mile, which the shared rules read as a delivery.
    'Item deposited to local postal operator',
    // A carrier's facility, seen after Landmark's processing.
    'Package scanned at carrier facility'].map(wording => [wording, { status: 'in_transit', stage: 'in_transit' }] as [string, ClassifiedStatus]),
]);

export function landmarkStatus(wording: string): ClassifiedStatus | undefined { return WORDINGS.get(wording); }

/** Each label's stage by its normalized wording, left out where two labels fold together with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const [label, { stage }] of WORDINGS) {
  const wording = normalizeStatusWording(label);
  STAGE_BY_WORDING.set(wording, STAGE_BY_WORDING.has(wording) && STAGE_BY_WORDING.get(wording) !== stage ? undefined : stage);
}

/** What the map says about one scan: Landmark's own label, as the parser reads it; a delivery is stored as "Delivered". */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STAGE_BY_WORDING.get(wording), gaps: [] };
