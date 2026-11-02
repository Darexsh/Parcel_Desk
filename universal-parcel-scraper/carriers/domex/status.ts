import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status lines of Domex's tracking table, which carry no code, by the
 * action before the branch, hub or department that recorded it. Only actions
 * seen on the tracker are mapped; another falls to the shared rules. Domex's
 * customer is the sender, so a return to the customer is a return.
 */
const ACTIONS: ReadonlyMap<string, Stage> = new Map([
  ['waiting to pickup', 'registered'], // Booked; waiting at the sender's premises for a pickup.
  ['parcel received', 'in_transit'], // A branch took the parcel in.
  ['parcel send to sort facility', 'in_transit'], // A branch sent it to the sorting hub.
  ['arrived at sort facility', 'in_transit'],
  ['in transit', 'in_transit'], // Left the hub for a branch.
  ['out for delivery', 'out_for_delivery'],
  ['reschedule', 'failed_attempt'], // A delivery round that did not deliver, moved to another day.
  ['hold', 'exception'], // Kept at the branch instead of going out, or after a round.
  ['return to next branch', 'returned'], // The delivering branch sent it back towards the sender.
  ['return to customer', 'returned'], // Handed back to the sender.
  ['return to customer confirmed', 'returned'],
]);

/** A line in the form the map keys it on: lower case, single spaces, without who recorded it. */
function actionKey(wording: string): string {
  return wording.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim().replace(/ by \S.*$/, '');
}

/** The stage Domex's actions give a scan, if the map knows it. */
export function domexMappedStage(wording: string): Stage | undefined {
  return ACTIONS.get(actionKey(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function domexStage(wording: string): ClassifiedWording | null {
  const mapped = domexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (actionKey(wording) === 'complete') return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : domexMappedStage(wording)),
  gaps: [
    { wording: 'complete by ho - finance', note: 'The head office closing the waybill\'s accounts after the parcel\'s journey ended; it moves nothing.' },
  ],
};
