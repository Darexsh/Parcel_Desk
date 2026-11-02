import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const DELIVERED: ClassifiedStatus = { stage: 'delivered', status: 'delivered' };
const TRANSIT: ClassifiedStatus = { stage: 'in_transit', status: 'in_transit' };
const EXCEPTION: ClassifiedStatus = { stage: 'exception', status: 'exception' };
const RETURNED: ClassifiedStatus = { stage: 'returned', status: 'exception' };
const REASONS = new Map<string, ClassifiedStatus>([['1', DELIVERED], ['2', EXCEPTION], ['3', TRANSIT], ['4', RETURNED], ['6', EXCEPTION]]);
// Code 70 is read by its reason. The frontend groups reasons 5, 7 and 65 with
// the delivery round; the remarks of the others say an address the courier
// could not reach, or a parcel left at a post office or pickup point for the
// recipient.
const UNDELIVERED = new Map<string, ClassifiedStatus>([
  ...['5', '7', '65'].map((reason) => [reason, { stage: 'out_for_delivery', status: 'out_for_delivery' } as const] as const),
  ['4', { stage: 'failed_attempt', status: 'exception' }],
  ['222', { stage: 'ready_for_pickup', status: 'out_for_delivery' }],
]);
// Without a reason it knows, code 70 is read by its remark: the courier waits at a receiving
// warehouse that inspects the parcel before it accepts it, the step before the delivery.
const UNDELIVERED_REMARKS: readonly (readonly [RegExp, ClassifiedStatus])[] = [
  [/^The shipment has arrived at the warehouse and is waiting for inspection and acceptance\b/i, { stage: 'out_for_delivery', status: 'out_for_delivery' }],
];
const SUMMARY = new Map<string, ClassifiedStatus>([['2', EXCEPTION], ['3', TRANSIT], ['4', RETURNED], ['5', EXCEPTION], ['6', EXCEPTION], ['99', TRANSIT], ['100', DELIVERED]]);

// The official Taiwan frontend's operation-code groups, plus codes observed in
// its public route response whose remarks settle them. The warehouse
// "delivered" group means dispatched. Code 99 is read by its remark.
const CODES = new Map<string, ClassifiedStatus>([
  ...['80', '980'].map((code) => [code, DELIVERED] as const),
  ...['50', '54', '950'].map((code) => [code, { stage: 'accepted', status: 'in_transit' } as const] as const),
  ...['44', '34', '122', '123', '630', '640', '83', '47', '634', '125', '204']
    .map((code) => [code, { stage: 'out_for_delivery', status: 'out_for_delivery' } as const] as const),
  ...['14', '30', '31', '36', '105', '106', '88', '89', '205', '201', '206', '646', '202', '626']
    .map((code) => [code, TRANSIT] as const),
  // In transit, on the road, on a flight or at a stopover, departed or arrived.
  ...['98', '208', '649', '310', '115', '116', '302', '305', '570'].map((code) => [code, TRANSIT] as const),
  // An international leg: departed from or arrived at a transit place on a flight, and waiting at one.
  ...['10', '11', '1105', '1106'].map((code) => [code, TRANSIT] as const),
  ...['605', '16'].map((code) => [code, { stage: 'customs', status: 'in_transit' } as const] as const),
]);

// Code 99 carries several notices: one on its way back to the sender, or one
// sent on to another address. Other remarks stay unclassified.
const NOTICES: readonly (readonly [RegExp, ClassifiedStatus])[] = [
  [/^The shipment is being returned\.?$/i, RETURNED],
  [/^The shipment is being forwarded\.?$/i, TRANSIT],
];

/** Codes 8000 and 70 are ambiguous without their reason, 70 and 99 without their remark; do not default them to signed. */
export function sfExpressEventStatus(code: string, reason: string, remark = ''): ClassifiedStatus | undefined {
  if (code === '8000') {
    return REASONS.get(reason);
  }
  if (code === '70') return UNDELIVERED.get(reason) ?? UNDELIVERED_REMARKS.find(([wording]) => wording.test(remark.trim()))?.[1];
  if (code === '99') return NOTICES.find(([wording]) => wording.test(remark.trim()))?.[1];
  return CODES.get(code);
}

/**
 * What the map says about one scan by its operation code, and code 99 by its
 * remark, which is the scan's wording. Codes 8000 and 70 are read by a reason
 * the provider code does not carry, so the code alone gives them no stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? sfExpressEventStatus(code, '', wording)?.stage : undefined),
  gaps: [],
};

export function sfExpressSummaryStatus(state: string, signed: boolean): ClassifiedStatus | undefined {
  const explicit = SUMMARY.get(state);
  return explicit ?? (signed ? DELIVERED : undefined);
}
