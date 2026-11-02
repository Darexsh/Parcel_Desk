import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Ekart words a scan as prose ("Shipment Created", "Received at ExampleHub")
// or as an operational code followed by its hub ("InscannedAtDH - ExampleHub").
const STAGES = new Map<string, Stage>(Object.entries({
  pickuprequested: 'registered', shipmentcreated: 'registered',
  // A pickup run, or one that failed, leaves the parcel with the seller.
  outforpickupevent: 'registered', notpickedevent: 'registered',
  pickupfromseller: 'accepted', pickupreceived: 'accepted',
  shipmentgrouped: 'in_transit', shipmentintransit: 'in_transit', dispatchedtotc: 'in_transit', dispatched: 'in_transit',
  // "Expected" announces the parcel at the hub it is travelling to.
  expected: 'in_transit', received: 'in_transit', inscannedatfacility: 'in_transit',
  inscannedatdh: 'in_transit', primarydhinscan: 'in_transit',
  outfordelivery: 'out_for_delivery', delivered: 'delivered',
  undeliveredattempted: 'failed_attempt', undeliveredunattempted: 'failed_attempt',
  pickupcancel: 'exception', shipmentrtoconfirmed: 'exception',
  rtoexpected: 'in_transit', rtoreceived: 'in_transit', returninscanned: 'in_transit',
} satisfies Record<string, Stage>));

const key = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');

/** The code of a code-shaped scan, its mapped stage, and whether it starts or continues a return. */
export function ekartScan(description: string): { code?: string; stage?: Stage; returning: boolean } {
  const coded = /^([A-Za-z]+(?:_[A-Za-z]+)*) - \S/.exec(description);
  const code = coded?.[1];
  const stage = code ? STAGES.get(key(code)) : /^received at \S/i.test(description) ? 'in_transit' : STAGES.get(key(description));
  return { ...(code ? { code } : {}), ...(stage ? { stage } : {}), returning: !!code && /^(?:rto|return|shipmentrto)/i.test(code) };
}

/**
 * What the map says about one scan: its wording, prose or a code before its hub, as the adapter
 * reads it. A delivery after an RTO scan reaches the seller, and the stored scan does not keep
 * the scans before it, so it stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const { stage } = ekartScan(wording);
    return stage === 'delivered' ? undefined : stage;
  },
  gaps: [{ wording: 'delivered', note: 'Delivered to the recipient, or back to the seller once an earlier RTO scan started the return leg: the stored scan does not keep the scans before it.' }],
};
