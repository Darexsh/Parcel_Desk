import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One Speedy operation code or shipment phase: its English wording and stage. */
interface SpeedyStatus {
  readonly wording: string;
  readonly stage?: Stage;
}

// Scan codes are the track-and-trace operation codes of Speedy's REST API
// documentation, worded as its English tracker words them where a reply
// showed it. "Received in Office" is an office taking the parcel from a
// courier or a counter, which can be its first acceptance as well as a
// later depot.
const OPERATIONS = new Map<string, SpeedyStatus>([
  ['148', { wording: 'Shipment data received', stage: 'registered' }],
  ['39', { wording: 'Courier Pick-up', stage: 'accepted' }],
  ['11', { wording: 'Received in Office', stage: 'in_transit' }],
  ['2', { wording: 'Departure Scan', stage: 'in_transit' }],
  ['1', { wording: 'Arrival Scan', stage: 'in_transit' }],
  ['21', { wording: 'Processed in Office', stage: 'in_transit' }],
  ['38', { wording: 'Returned to Office', stage: 'in_transit' }],
  ['115', { wording: 'Redirected', stage: 'in_transit' }],
  ['116', { wording: 'Forwarded', stage: 'in_transit' }],
  ['152', { wording: 'Routed to another Speedy Location', stage: 'in_transit' }],
  ['176', { wording: 'Export to foreign provider', stage: 'in_transit' }],
  ['217', { wording: 'Handover to midway carrier', stage: 'in_transit' }],
  ['12', { wording: 'Out for Delivery', stage: 'out_for_delivery' }],
  ['44', { wording: 'Unsuccessful Delivery', stage: 'failed_attempt' }],
  ['134', { wording: 'Prepared for Self-collecting by Consignee', stage: 'ready_for_pickup' }],
  ['1134', { wording: 'Office/Locker ready for pickup message sent', stage: 'ready_for_pickup' }],
  ['-14', { wording: 'Delivered', stage: 'delivered' }],
  ['111', { wording: 'Return to Sender', stage: 'returned' }],
  ['124', { wording: 'Delivered Back to Sender', stage: 'returned' }],
  ['112', { wording: 'Processed to the Insurance dept.', stage: 'exception' }],
  ['114', { wording: 'Processed for Destruction', stage: 'exception' }],
  ['120', { wording: 'Refusal to send', stage: 'exception' }],
  ['121', { wording: 'Stopped by Sender', stage: 'exception' }],
  ['123', { wording: 'Refused by recipient', stage: 'exception' }],
  ['125', { wording: 'Destroyed', stage: 'exception' }],
  ['127', { wording: 'Theft/Burglary', stage: 'exception' }],
  ['128', { wording: 'Canceled', stage: 'exception' }],
  ['129', { wording: 'Administrative Closure', stage: 'exception' }],
  ['136', { wording: 'Clarify shipment delivery', stage: 'exception' }],
  ['164', { wording: 'Unsuccessful shipment pickup', stage: 'exception' }],
  ['169', { wording: 'Delivery capacity reached (tour/office)', stage: 'exception' }],
  ['181', { wording: 'Unexpected delay', stage: 'exception' }],
  ['190', { wording: 'Postponed delivery due to inaccurate/incomplete address', stage: 'exception' }],
  ['69', { wording: 'Deferred delivery' }],
  ['144', { wording: 'Handover for contents check/test' }],
  ['195', { wording: 'Refuse contents check/test' }],
  ['175', { wording: 'Predict' }],
]);

// The shipment's phase, which the reply sends beside its scans. The adapter
// reads it only when a reply holds no scan. The phases are the ones the
// official app names; HANDED_FOR_DELIVERY follows FILLED_IN there.
const PHASES = new Map<string, SpeedyStatus>([
  ['FILLED_IN', { wording: 'Created', stage: 'registered' }],
  ['HANDED_FOR_DELIVERY', { wording: 'Handed over for delivery', stage: 'accepted' }],
  ['IN_TRANSIT', { wording: 'In transit', stage: 'in_transit' }],
  ['AT_DELIVERY_CENTER', { wording: 'At the delivery centre', stage: 'in_transit' }],
  ['PREPARED_FOR_SELF_COLLECTING_CONSIGNEE', { wording: 'Prepared for self-collecting by consignee', stage: 'ready_for_pickup' }],
  ['OUT_FOR_DELIVERY', { wording: 'Out for delivery', stage: 'out_for_delivery' }],
  ['UNSUCCESSFUL_DELIVERY', { wording: 'Unsuccessful delivery', stage: 'failed_attempt' }],
  ['DELIVERED', { wording: 'Delivered', stage: 'delivered' }],
  ['RETURN_TO_SENDER', { wording: 'Return to sender', stage: 'returned' }],
  ['DELIVERED_BACK_TO_SENDER', { wording: 'Delivered back to sender', stage: 'returned' }],
  ['CANCELED', { wording: 'Canceled', stage: 'exception' }],
]);

/** A scan's operation code: its documented wording and stage, or the code alone when the map does not know it. */
export function speedyOperation(code: string): SpeedyStatus {
  return OPERATIONS.get(code) ?? { wording: code };
}

/** A shipment phase, or undefined when the map does not know it. */
export function speedyPhase(phase: string): SpeedyStatus | undefined {
  return PHASES.get(phase);
}

/** Scans at the handover that do not move the parcel: a pickup point stays the one it was collected from. */
export const CONTENTS_CHECK_CODES: ReadonlySet<string> = new Set(['144', '195']);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? (OPERATIONS.get(code) ?? PHASES.get(code))?.stage : undefined),
  gaps: [
    { code: '69', note: 'A delivery moved to a later day. The code does not say whether a courier tried or the recipient asked for it.' },
    { code: '144', note: 'The recipient checks the contents before accepting the parcel, at the door or at an office; it moves nothing.' },
    { code: '195', note: 'The recipient declines to check the contents before accepting the parcel; it moves nothing.' },
    { code: '175', note: 'A delivery forecast sent to the recipient, not a scan.' },
  ],
};
