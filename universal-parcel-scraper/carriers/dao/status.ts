import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * DAO numbers its scan events separately for each leg, home delivery (`Home`)
 * and daoSHOP (`Shop`), and the same number means different things on the
 * two: Home 11 delivers a parcel to the door, Shop 11 brings it into a
 * terminal. A scan's provider code is its leg, a slash and its event number,
 * as `Shop/32`. A parcel whose home delivery fails is sent to a daoSHOP, and
 * its later scans are on the Shop leg.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The sender's data, before DAO has the parcel.
  ['Home/1', 'registered'],
  ['Shop/1', 'registered'],
  // Handed in at a daoSHOP by the sender.
  ['Shop/25', 'accepted'],
  ['Home/10', 'in_transit'],
  ['Home/35', 'in_transit'],
  ['Shop/11', 'in_transit'],
  ['Shop/12', 'in_transit'],
  ['Shop/16', 'in_transit'],
  ['Shop/23', 'in_transit'],
  ['Shop/26', 'in_transit'],
  // The parcel is on the day's delivery round.
  ['Home/31', 'out_for_delivery'],
  ['Home/61', 'failed_attempt'],
  // A failed home delivery: the parcel goes on to a daoSHOP.
  ['Home/64', 'failed_attempt'],
  ['Shop/32', 'ready_for_pickup'],
  ['Home/11', 'delivered'],
  // Collected at the daoSHOP.
  ['Shop/51', 'delivered'],
]);

/** A leg and an event number: `Home/11`. */
export const CODE = /^(?:[A-Za-z]{1,20}\/)?\d{1,4}$/;

/** The stage a scan's leg and event number give a parcel, if the map knows them. */
export function daoStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** The scan's provider code: its leg and event number, or the number alone without a leg. */
export function daoCode(leg: string, event: string): string {
  return leg ? `${leg}/${event}` : event;
}

/** The map reads the whole code: the same event number means different things on each leg. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [],
};
