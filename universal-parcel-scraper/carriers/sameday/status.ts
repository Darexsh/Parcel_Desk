import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Every scan carries a status (statusId, the wording) and the state it belongs
// to (statusStateId). The public reply names the states but does not list
// them; the official app's AwbStatus enum does, and its labels say what each
// one means. The adapter stages a scan by its state.
const STATES: Readonly<Record<string, Stage>> = {
  '1': 'registered', // ORDER_OF_PARCELS_PLACED
  '2': 'accepted', // AT_COURIER
  '3': 'in_transit', // IN_COURIER_WAREHOUSE, the local depot
  '4': 'out_for_delivery', // DELIVERY_IN_PROGRESS, to the door or to an easybox
  '5': 'delivered', // PARCELS_DELIVERED
  '6': 'exception', // EXPIRED_CANCELLED: storage expired, or refused
  '7': 'in_transit', // TRANSIT
  '8': 'returned', // SUCCESSFULLY_RETURNED
  '10': 'failed_attempt', // DELIVERY_FAILED
  '11': 'exception', // SENDER_CANCELLED
  '13': 'returned', // PICKED_UP_RETURN, from the recipient
  '14': 'returned', // ONGOING_RETURN
  '15': 'returned', // RETURN_IN_OOH, a return left in a pickup point
  '16': 'exception', // PICKUP_FAILED, at the sender
  '17': 'in_transit', // ORDER_IN_CENTRAL_WAREHOUSE
  '18': 'ready_for_pickup', // LOADED_IN_OOH, an easybox or pickup point
  '19': 'in_transit', // IN_INTERNATIONAL_TRANSIT
  '20': 'exception', // SAMEDAY_POINT_CROWDED, the easybox is full
  '21': 'in_transit', // PARCEL_KEPT_IN_CENTRAL_WAREHOUSE
  '22': 'exception', // SAMEDAY_POINT_TEMPORARY_UNAVAILABLE
  '23': 'exception', // INCOMPLETE_DELIVERY, some parcels of the AWB only
  '27': 'ready_for_pickup', // PARCEL_REDIRECTED_TO_INITIAL_EASYBOX, loaded there
  '29': 'exception', // PARCEL_UNAVAILABLE_FOR_DELIVERY
  '30': 'exception', // PARCEL_CANNOT_BE_DELIVERED
};

/**
 * Redirection and postponement instructions: ORDER_REDIRECTED (9),
 * DELIVERY_POSTPONED (12) and PARCEL_REDIRECTED_TO_OOH, _TO_ADDRESS and
 * _TO_ANOTHER_OOH (24 to 26). They can come before the pickup and say nothing
 * about where the parcel is, so they keep the stage of the scan before them.
 */
export const INSTRUCTIONS: ReadonlySet<string> = new Set(['9', '12', '24', '25', '26']);

// Statuses the app reads before their state: 46 is a completed return and 74 a
// refusal by the recipient.
const RETURNED_STATUS = '46';
const REFUSED_STATUS = '74';

// A movement on the return leg (the scan's inReturn flag) brings the parcel
// back to its sender. The app reads states 4 and 5 that way; the other
// forward states are the same journey.
const FORWARD: ReadonlySet<Stage> = new Set(['accepted', 'in_transit', 'out_for_delivery', 'delivered', 'ready_for_pickup']);

/**
 * A scan's stage from its state, its status and the return flag. A state the
 * map does not know goes to the shared wording rules, first on the scan's
 * wording, then on the state's own; an instruction has no stage of its own.
 */
export function samedayStage(state: string, status: string, inReturn: boolean, wording: string, stateWording: string): ClassifiedWording | null {
  if (status === RETURNED_STATUS) return { stage: 'returned', source: 'carrier_map' };
  if (status === REFUSED_STATUS) return { stage: 'exception', source: 'carrier_map' };
  if (INSTRUCTIONS.has(state)) return null;
  const mapped = Object.hasOwn(STATES, state) ? STATES[state]! : undefined;
  if (mapped) return { stage: inReturn && FORWARD.has(mapped) ? 'returned' : mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none' || !stateWording) return worded;
  return classifyWording(stateWording, 'in_transit');
}

/** The provider code is the state, a slash and the status: "4/33". */
export function samedayCode(state: string, status: string): string {
  return `${state}/${status}`;
}

/**
 * The stage this map gives one scan by its code alone. A forward state's
 * stage depends on the scan's return flag, which the code lacks, and a state
 * the map does not list is staged by its wording, so the map does not answer
 * for them. Gaps are keyed by state.
 */
export const statusMap: CarrierStatusMap = {
  codeKey: (code) => code.split('/')[0] ?? code,
  stage: (code) => {
    const match = code ? /^(\d{1,6})(?:\/(\d{1,8}))?$/.exec(code) : null;
    if (!match) return undefined;
    const [, state, status] = match;
    if (status === RETURNED_STATUS) return 'returned';
    if (status === REFUSED_STATUS) return 'exception';
    const mapped = Object.hasOwn(STATES, state!) ? STATES[state!] : undefined;
    return mapped && !FORWARD.has(mapped) ? mapped : undefined;
  },
  gaps: [
    { code: '9', note: 'A redirection order, not a movement: it keeps the stage of the scan before it.' },
    { code: '12', note: "A delivery postponed at the recipient's request, not a movement: it keeps the stage of the scan before it." },
    { code: '24', note: 'A redirection to a pickup point, not a movement: it keeps the stage of the scan before it.' },
    { code: '25', note: 'A redirection to the address after an easybox could not take the parcel, not a movement: it keeps the stage of the scan before it.' },
    { code: '26', note: 'A redirection to another pickup point, not a movement: it keeps the stage of the scan before it.' },
  ],
};
