import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The state names Evropat's tracking lookup gives each step, in Bulgarian.
 * The lookup sends no code, so a step is read by its whole name.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['създадена', 'registered'], // The sender created the waybill.
  ['разпечатана', 'registered'], // The label was printed, once per print.
  ['приета от куриер', 'accepted'], // A courier collected the parcel.
  ['приета в офис', 'accepted'], // Taken into an office's depot, by a courier or over the counter.
  ['натоварена от офис', 'in_transit'], // Loaded on a line from one office to the next.
  ['разтоварена в офис', 'in_transit'], // Unloaded at the next office.
  ['групирана', 'in_transit'], // Grouped with other parcels at an office.
  ['разгрупирана', 'in_transit'], // Taken out of its group at an office.
  ['в куриер за разнос', 'out_for_delivery'],
  ['разнесена', 'delivered'],
]);

/** The stage of a state name, or nothing for one the map does not name. */
export function evropatStage(name: string): Stage | undefined {
  return STATES.get(normalizeStatusWording(name));
}

/** Steps carry no code: the map reads the state name. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => evropatStage(wording),
  gaps: [],
};
