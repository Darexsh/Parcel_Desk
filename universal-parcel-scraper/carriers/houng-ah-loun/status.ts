import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * HAL Express's `delivery_state` codes, which its tracking page labels. The
 * page knows 1 to 7; 11 came in a live reply. Another code keeps no stage:
 * its message is Lao the shared wording rules cannot read.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Pending: the bill exists and the parcel is not with HAL yet.
  ['2', 'accepted'], // Accept: a branch took the parcel in.
  ['3', 'in_transit'], // Packing: at a branch, a branch's warehouse or a sorting centre.
  ['4', 'in_transit'], // On the way to the next branch, warehouse or centre.
  // "Delivered": at the destination branch, whose message invites the
  // recipient to collect it there before a date, after which it goes back.
  ['5', 'ready_for_pickup'],
  ['6', 'delivered'], // Success: collected.
  ['7', 'exception'], // The page's "abnormal state".
  ['11', 'exception'], // Customer request to return: the parcel goes back to the branch it came from.
]);

/** The code of the scan that sends a parcel back to its sending branch. */
export const RETURN_STATE = '11';

/** The stage HAL Express's code gives a scan on the way to the recipient. */
export function halMappedStage(code: string): Stage | undefined {
  return STATES.get(code);
}

/**
 * A scan's stage. After a return, the arrival at the sending branch and the
 * collection there end the return rather than reaching the recipient; the
 * movement in between stays movement.
 */
export function halStage(code: string, returning: boolean): ClassifiedWording | null {
  const mapped = halMappedStage(code);
  if (!mapped) return null;
  if (returning && (code === '5' || code === '6')) return { stage: 'returned', source: 'carrier_map' };
  return { stage: mapped, source: 'carrier_map' };
}

/** The codes whose stage depends on whether a return came before them in the history. */
const LEG_DEPENDENT = new Set(['5', '6']);

/**
 * What the map says about one scan, by its code. An arrival or a collection is
 * the recipient's or, after a return, the sender's: only the history tells, so
 * the code alone answers neither.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && !LEG_DEPENDENT.has(code) ? halMappedStage(code) : undefined),
  gaps: [],
};
