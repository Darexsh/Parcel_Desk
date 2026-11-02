import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Each scan names its milestone (`group`) and the leg it belongs to (`state`):
// `delivery` on the way to the recipient, `return` back to the sender and
// `dispose` for a parcel that will not arrive. The tracker's own labels name
// the groups; a redirection sends the parcel on to another point or network.
const GROUPS: Readonly<Record<string, Stage>> = {
  created: 'registered',
  shipped: 'accepted',
  in_transit: 'in_transit',
  redirected: 'in_transit',
  left_our_network: 'in_transit',
  ready_for_pickup: 'ready_for_pickup',
  delivered: 'delivered',
  return: 'returned',
  returned: 'returned',
  lost: 'exception',
  disposed: 'exception',
  cancelled: 'exception',
  empty_locker_found: 'exception',
};

const LEGS = new Set(['delivery', 'return', 'dispose']);

/** The provider code of a scan: its leg, a slash and its milestone ("return/in_transit"). */
export function vintedGoCode(state: string, group: string): string {
  return `${state}/${group}`;
}

/**
 * A scan's stage from its leg and milestone. Every movement on the return leg
 * takes the parcel back to its sender, so it is `returned`; a loss or a
 * cancellation stays an exception on any leg. A leg or milestone the map does
 * not know is left to the shared wording rules.
 */
export function vintedGoStage(state: string, group: string): Stage | undefined {
  if (!LEGS.has(state) || !Object.hasOwn(GROUPS, group)) return undefined;
  const stage = GROUPS[group]!;
  return state === 'return' && stage !== 'exception' ? 'returned' : stage;
}

/** What the map says about one scan, by its provider code alone. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => {
    const [state, group, ...rest] = (code ?? '').split('/');
    return state && group && !rest.length ? vintedGoStage(state, group) : undefined;
  },
  gaps: [{
    code: 'delivery/oversized',
    note: 'The tracker names an oversized parcel, which it then redirects to a larger point. No reply showed one, so it is left to the wording rules.',
  }],
};
