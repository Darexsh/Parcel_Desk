import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Flash Express's scan `route_action` codes. Flash's open platform documents
 * them with the English wording of each; CLOSE_ORDER, FLASH_HOME_SCAN,
 * CANCEL_SHIPMENT_WAREHOUSE and DELIVERY_MARKER are codes its tracker uses
 * that the list leaves out.
 */
const ACTIONS: ReadonlyMap<string, Stage> = new Map([
  ['RECEIVED', 'accepted'], // Picked up by a courier, a branch or a Flash Home agent.
  ['RECEIVE_WAREHOUSE_SCAN', 'accepted'], // Booked in at the first branch.
  ['FLASH_HOME_SCAN', 'in_transit'], // A Flash Home agent sends the parcel on to its branch.
  ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit'], // Left one branch or hub for the next.
  ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit'],
  // The parcel is still at a hub after the time it was due to leave.
  ['CANCEL_SHIPMENT_WAREHOUSE', 'in_transit'],
  ['DIFFICULTY_RE_TRANSIT', 'in_transit'], // A problem parcel moves on.
  ['CHANGE_PARCEL_IN_TRANSIT', 'in_transit'], // Reopened after a closure: it moves on.
  ['DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery'],
  ['CONTINUE_TRANSPORT', 'out_for_delivery'], // Out for delivery again.
  ['DETAIN_WAREHOUSE', 'failed_attempt'], // Kept at the branch, undelivered, with the reason.
  ['DELIVERY_MARKER', 'failed_attempt'], // A delivery that failed, with the reason.
  ['DELIVERY_CONFIRM', 'delivered'],
  ['CHANGE_PARCEL_SIGNED', 'delivered'], // Marked signed for by Flash's staff.
  ['DIFFICULTY_HANDOVER', 'exception'], // Handed to the problem-parcel desk.
  ['CANCEL_PARCEL', 'exception'], // Withdrawn.
  ['CHANGE_PARCEL_CANCEL', 'exception'], // Withdrawn by Flash's staff.
  ['CHANGE_PARCEL_CLOSE', 'exception'], // Closed: delivery stopped, or the parcel was lost.
  ['CLOSE_ORDER', 'exception'], // Delivery stopped.
  ['DIFFICULTY_FINISH_INDEMNITY', 'exception'], // Compensation paid for a lost or damaged parcel.
  ['SYSTEM_AUTO_RETURN', 'returned'],
]);

/** Scans the map leaves without a stage on purpose: none moves the parcel. */
const GAP_NOTES = [
  { code: 'PHONE', note: 'The courier called the recipient. The page lists the calls under it; the parcel does not move.' },
  { code: 'HURRY_PARCEL', note: 'A customer asked Flash to hurry the parcel. It is logged whatever state the parcel is in.' },
  { code: 'CHANGE_PARCEL_INFO', note: "Flash's staff changed the parcel's details." },
  { code: 'CUSTOMER_CHANGE_PARCEL_INFO', note: "The customer changed the parcel's details." },
  { code: 'REVISION_TIME', note: 'The recipient chose another delivery time.' },
] as const;
const GAPS = new Set<string>(GAP_NOTES.map((gap) => gap.code));

/** The stage Flash's codes give a scan code. */
export function flashExpressMappedStage(code: string): Stage | undefined {
  return ACTIONS.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function flashExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = flashExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? flashExpressMappedStage(code) : undefined),
  gaps: GAP_NOTES,
};
