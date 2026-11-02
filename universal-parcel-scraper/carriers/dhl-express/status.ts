/**
 * DHL Express checkpoint wording. Both the guest mobile API and the public
 * web tracking send DHL's English checkpoint sentences, several of which end
 * with the facility ("Processed at PARIS - FRANCE"), so those are matched on
 * their fixed start. Other wording goes to the shared classifier.
 */
import { classifyWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const EXACT: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  // The shipper's further data, such as customs paperwork, joined to the shipment's record.
  ['supplementary information has been received and merged with applicable shipment data', 'registered'],
  ['shipment picked up', 'accepted'],
  ['shipment accepted', 'accepted'],
  // A clearance step without its outcome: the parcel is still in customs.
  ['clearance event', 'customs'],
  // The recipient owes duties or fees, which hold the parcel until they are paid; then they are paid,
  // and the clearance they held up completes next.
  ['on hold awaiting for payment of shipment related fees', 'customs'],
  ['payment is received and recorded for shipment related fees', 'customs'],
  ['shipment is in transit to destination', 'in_transit'],
  // Waiting at a facility for the next linehaul or flight: on its way, not held.
  ['scheduled to depart on the next planned movement', 'in_transit'],
  // A delivery booked for a later round, as after a failed attempt: not yet with the courier.
  ['shipment is scheduled for delivery', 'in_transit'],
  ['shipment is out with courier for delivery', 'out_for_delivery'],
  ['shipment is on hold', 'exception'],
  ['delivered', 'delivered'],
  // Sent back: the shipper, not the consignee, has the parcel.
  ['returned to shipper', 'returned'],
]);

const PREFIXES: ReadonlyArray<readonly [string, Stage]> = [
  ['delivery attempted', 'failed_attempt'],
  ['delivery attempt could not be completed', 'failed_attempt'],
  // Held at a DHL facility for the consignee to collect.
  ['awaiting collection by ', 'ready_for_pickup'],
  // A missort: DHL forwards the parcel to the right facility, late.
  ['shipment arrived at incorrect facility', 'exception'],
  // A completed clearance puts the parcel back in transit; one still running stays in customs.
  ['clearance processing complete', 'in_transit'],
  ['clearance processing', 'customs'],
  ['processed for clearance at ', 'customs'],
  ['customs clearance', 'customs'],
  ['processed at ', 'in_transit'],
  ['arrived at dhl sort facility', 'in_transit'],
  ['arrived at dhl delivery facility', 'in_transit'],
  ['shipment has departed from a dhl facility', 'in_transit'],
];

/**
 * DHL's event codes on the unified feed, each seen with the wording above: SA
 * the shipment's acceptance, IC its processing for clearance, CD a clearance
 * step without its outcome, PY the payment of fees during clearance, MS a
 * missort, SM the wait for the next planned movement, CC the wait for the
 * consignee's collection, ND a delivery attempt that could not be completed,
 * RT the return to the shipper. They stage a scan
 * whose wording the map does not know, as in another language.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['SA', 'accepted'], ['IC', 'customs'], ['CD', 'customs'], ['PY', 'customs'], ['MS', 'exception'], ['SM', 'in_transit'],
  ['CC', 'ready_for_pickup'], ['ND', 'failed_attempt'], ['RT', 'returned'],
]);

/** The checkpoint's stage from DHL's own wording, if the wording is one of DHL's checkpoints. */
export function dhlExpressCheckpointStage(description: string): Stage | undefined {
  const text = description.toLowerCase();
  return EXACT.get(text) ?? PREFIXES.find(([start]) => text.startsWith(start))?.[1];
}

/** The checkpoint's stage from its wording, else from the unified feed's event code. */
function checkpointStage(description: string, code?: string | null): Stage | undefined {
  return dhlExpressCheckpointStage(description) ?? (code ? CODES.get(code.trim().toUpperCase()) : undefined);
}

export function dhlExpressStage(description: string, code?: string | null): { stage: Stage; source: string } {
  const stage = checkpointStage(description, code);
  return stage ? { stage, source: 'carrier_map' } : classifyWording(description, 'pending');
}

/** What the map says about one scan: its checkpoint wording, else its event code. The web feed has no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => checkpointStage(wording, code),
  gaps: [],
};
