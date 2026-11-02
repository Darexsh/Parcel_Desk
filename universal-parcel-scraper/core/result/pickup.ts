/**
 * Whether a delivered parcel was collected from its pickup point or brought to
 * the door, read from its scans. The app reads its stored scans the same way.
 */
import { explicitOffsetTime } from '../time/index.js';
import type { CarrierEvent, CarrierResult } from './index.js';

/** Stages that move a parcel: notices, problem reports and a delivery itself do not. */
const MOVEMENTS = new Set(['in_transit', 'customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'returned']);

/**
 * The stage of the newest scan that moved the parcel, from scans given newest
 * first. For a delivered parcel, `ready_for_pickup` means it was collected from
 * its pickup point and `out_for_delivery` that it was brought to the door; one
 * sent on or returned was not collected there either. A scan without a stage
 * may have moved it, so it ends the search with no answer, as does a history in
 * which nothing moved.
 */
export function lastMovement(events: readonly CarrierEvent[]): string | undefined {
  for (const { stage } of events) {
    if (!stage) return undefined;
    if (MOVEMENTS.has(stage)) return stage;
  }
  return undefined;
}

/** The scans newest first: by instant when every clock has an offset, else as given. */
function newestFirst(events: readonly CarrierEvent[]): readonly CarrierEvent[] {
  const instants = events.map((event) => explicitOffsetTime(event.time)?.timestamp);
  if (instants.some((instant) => instant === undefined)) return events;
  return events.map((event, index) => ({ event, instant: instants[index]! }))
    .sort((left, right) => right.instant - left.instant).map(({ event }) => event);
}

/**
 * Whether a delivered result's scans show it was brought to the door: the last
 * movement before the delivery took it out for delivery. A movement after the
 * delivery leaves their order in doubt, and a delivery without such a scan
 * before it proves nothing.
 */
export function deliveredToDoor(result: CarrierResult): boolean {
  if ((result.current_stage ?? (result.status === 'delivered' ? 'delivered' : undefined)) !== 'delivered') return false;
  const events = newestFirst(result.events ?? []);
  const delivery = events.findIndex((event) => event.stage === 'delivered');
  if (delivery < 0 || events.slice(0, delivery).some((event) => MOVEMENTS.has(event.stage ?? ''))) return false;
  return lastMovement(events.slice(delivery + 1)) === 'out_for_delivery';
}
