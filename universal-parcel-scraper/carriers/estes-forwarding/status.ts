import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * EFW's event codes, from the tracker's script and its replies. Another code
 * falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PUR', 'registered'], // Shipment Created: the shipper booked it.
  ['PUP', 'accepted'], // Picked Up from the shipper.
  ['OHO', 'in_transit'], // Arrived at Origin City: at EFW's origin terminal.
  ['INT', 'in_transit'],
  ['OHD', 'in_transit'], // Arrived at Destination City: at the terminal that delivers it.
  ['OFD', 'out_for_delivery'],
  ['DEL', 'delivered'],
  ['CLS', 'exception'], // Closed - Not Delivered.
  ['CXL', 'exception'], // The customer cancelled the order.
]);

/** The stage EFW's codes give an event code. */
export function estesForwardingMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** An event's stage: its code, else the shared wording rules, else nothing. */
export function estesForwardingStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = estesForwardingMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// The adapter leaves the appointment (APP), the estimate (ETD) and REC, which
// the tracker's own list hides, out of the history, so they have no stage.
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? estesForwardingMappedStage(code) : undefined),
  gaps: [
    { code: 'APP', note: 'A delivery appointment was booked; the event carries the appointment\'s time, not a scan\'s, and the tracker leaves it out of the current status.' },
    { code: 'ETD', note: 'The delivery estimate, given as an event; it becomes the estimate, not a scan.' },
  ],
};
