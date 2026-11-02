import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One BOX NOW parcel state or event type: the English wording the adapter gives it and its stage. */
interface BoxNowStatus {
  readonly wording: string;
  readonly stage?: Stage;
}

// The tracking API names each scan and the parcel's state with one vocabulary.
// Wordings follow the definitions in BOX NOW's partner API manual, else the
// English wording of its country sites' trackers. A parcel goes to the locker
// its recipient chose: final-destination is a parcel waiting there.
const STATUSES = new Map<string, BoxNowStatus>([
  ['new', { wording: 'Parcel has been registered in the system', stage: 'registered' }],
  ['accepted-to-locker', { wording: 'The parcel has been placed in the locker', stage: 'accepted' }],
  ['accepted-in-locker', { wording: 'The parcel has been placed in the locker', stage: 'accepted' }],
  ['in-transit', { wording: 'Parcel is being transferred to a specific location', stage: 'in_transit' }],
  ['in-depot', { wording: 'Parcel is in one of our warehouses', stage: 'in_transit' }],
  // Waiting in a locker for a courier, after a drop-off or an expired pickup.
  ['wait-for-load', { wording: 'Parcel is waiting in a specific APM to be taken over by BOX NOW courier', stage: 'in_transit' }],
  ['final-destination', { wording: 'Parcel has reached its final destination, waiting for pickup', stage: 'ready_for_pickup' }],
  ['in-final-destination', { wording: 'Parcel has reached its final destination, waiting for pickup', stage: 'ready_for_pickup' }],
  ['delivered', { wording: 'Parcel has been delivered', stage: 'delivered' }],
  ['returned', { wording: 'Parcel has been returned to the sender', stage: 'returned' }],
  ['expired', { wording: 'Expired', stage: 'exception' }],
  ['expired-return', { wording: 'Delivery has expired', stage: 'exception' }],
  ['missing', { wording: 'Parcel search - We will update you shortly', stage: 'exception' }],
  ['lost', { wording: 'Lost', stage: 'exception' }],
  ['canceled', { wording: 'Parcel order had been cancelled by the sender', stage: 'exception' }],
  ['cancelled', { wording: 'Parcel order had been cancelled by the sender', stage: 'exception' }],
  ['cancelled-return', { wording: 'Return of parcel, cancelled by sender', stage: 'exception' }],
  ['accepted-for-return', { wording: 'The parcel has been placed in the locker' }],
]);

/** The wording and stage of one state or event type; a type the map does not know keeps its code as wording. */
export function boxNowStatus(code: string): BoxNowStatus {
  return STATUSES.get(code) ?? { wording: code };
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STATUSES.get(code)?.stage : undefined),
  gaps: [{
    code: 'accepted-for-return',
    note: 'A parcel put back into a locker to go back. The trackers word it like a sender drop-off, and no reply showed whether it ends the delivery or starts a return to the sender.',
  }],
};
