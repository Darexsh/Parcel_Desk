import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The TruckMate status codes in M-O's trace. Its settings list nine for the
 * status history, which shows each with its description; M-O's Track and Trace
 * guide shows a few more in the customer portal's history. A truck's arrival
 * at the shipper and departure with the freight bracket the pickup, and its
 * arrival at the consignee starts the delivery. M-O has no separate delivery
 * code: the departure from the consignee ends it, and the order is completed
 * with it.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ARRSHIP', 'registered'], // The truck reached the shipper; the freight is not aboard yet.
  ['DEPSHIP', 'accepted'], // The truck left the shipper with the freight.
  ['DOCKED', 'in_transit'], // Docked for manifesting at a terminal.
  ['INTRANSIT', 'in_transit'],
  ['ARRCONS', 'out_for_delivery'], // The truck reached the consignee.
  ['DEPCONS', 'delivered'], // The truck left the consignee after unloading; M-O completes the order a second later.
  ['COMPLETE', 'delivered'], // The order is done; its delivery time is set then.
  ['FREIGHTNA', 'exception'], // The freight was not available; M-O's quick track asks the customer to call.
]);

/** The stage M-O's codes give a status code. */
export function maritimeOntarioMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

/** A status code's stage, or nothing. */
export function maritimeOntarioStage(code: string): ClassifiedWording | null {
  const stage = maritimeOntarioMappedStage(code);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? maritimeOntarioMappedStage(code) : undefined),
  gaps: [
    { code: 'DISP', note: 'A dispatch can be the pickup’s or the delivery’s; M-O’s quick track shows a dispatched order as scheduled for pickup.' },
    { code: 'APPTDEL', note: 'A delivery appointment says when the freight will be delivered, not where it is.' },
    { code: 'REQ-DLY-AP', note: 'The consignee asks for a delivery appointment, which says nothing of where the freight is.' },
  ],
};
