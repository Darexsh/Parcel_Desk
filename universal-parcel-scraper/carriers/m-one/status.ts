import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * M-ONE's scan codes. The tracker words each code from its current code
 * table, so a code keeps its stage when its wording changes. Only codes seen
 * in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ST01', 'registered'], // A pickup order was created.
  ['ST02', 'accepted'], // Collected from the sender.
  ['ST04', 'in_transit'], // At the delivering distribution centre.
  ['ST05', 'out_for_delivery'], // On the delivery vehicle.
  ['ST06', 'in_transit'], // Between depots: worded as local transit, earlier as the line-haul vehicle.
  ['ST07', 'delivered'],
  ['ST11', 'in_transit'], // Redirected.
  ['ST15', 'ready_for_pickup'], // Waiting in a parcel locker.
  ['ST33', 'out_for_delivery'], // Taken out for a parcel locker.
  ['ST35', 'failed_attempt'], // A delivery attempt; the recipient was left a notice.
  // The recipient will collect the parcel, which stays at the depot for them.
  ['ST48', 'ready_for_pickup'],
  ['ST52', 'in_transit'], // Redirected at the recipient's request.
]);

/** The stage M-ONE's codes give a scan code. */
export function mOneMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function mOneStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = mOneMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? mOneMappedStage(code) : undefined),
  gaps: [],
};
