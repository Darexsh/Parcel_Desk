import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan codes and the stage each gives a parcel on its way to the
 * recipient. The page words them in English or Hungarian and has reworded
 * several over time ("Hub inbound", then "Arrived at central hub"), so the map
 * reads the code. E05, a delivery tour stopped by the weather, counts as a
 * delivery attempt on the page. V14 is the last failed attempt before the
 * parcel goes back; the return leg that follows has a history of its own.
 */
const STAGES = new Map<string, Stage>([
  ['PRE', 'registered'],
  ['INB', 'in_transit'],
  ['OUB', 'in_transit'],
  ['DEP', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['D00', 'delivered'],
  ['E05', 'failed_attempt'],
  ['E12', 'failed_attempt'],
  ['V14', 'failed_attempt'],
]);

/**
 * Scans that move nothing: a delivery day planned again, by Express One or at
 * the recipient's request. They name no milestone, so the parcel keeps the
 * stage of the scan before them.
 */
const QUIET = new Map<string, string>([
  ['E17', 'The delivery day moved because the tour ran out of time; no courier tried.'],
  ['E40', 'A delivery moved to a later time; the page does not say why.'],
  ['E82', 'The delivery schedule was updated; it moves nothing.'],
  ['E92', 'The recipient chose another delivery day through Flexdel; it moves nothing.'],
]);

/** The stage a scan code gives a parcel on its way to the recipient, if any. */
export function expressOneStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** Whether a scan code moves nothing, so the parcel keeps the stage before it. */
export function expressOneQuiet(code: string): boolean {
  return QUIET.has(code);
}

/**
 * DLS, the shipment's data entering Express One's system, registers a parcel
 * when it comes first and is part of the hub's handling after a scan there, so
 * its stage depends on the rest of the history. Every scan of the return leg
 * is a return, whatever its code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [...QUIET].map(([code, note]) => ({ code, note })),
};
