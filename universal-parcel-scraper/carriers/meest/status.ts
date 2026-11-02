import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Meest's scan codes, the `StatusCode` of every row its tracker returns. Meest
 * Post's client API documentation lists most of them, several beside the UPU
 * event they stand for (101 is EMA, 1622 is EMI); the rest were seen on the
 * tracker or are named by its page script. Meest's own network, its partners
 * abroad and the consolidators it carries for write the same codes.
 *
 * A parcel at a branch or a locker waits for its recipient. Meest's "handed
 * to the courier" also comes before a branch pickup, when a courier takes the
 * parcel to a small partner branch. A finished customs check puts a parcel
 * back in transit.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // Created by the sender and not handed over yet.
  ['2', 'registered'],
  // The sender deleted the shipment.
  ['3', 'exception'],
  // A partner's registration, also its note of the final-mile partner to come.
  ['100', 'registered'],
  // At Meest's consolidation warehouse, made up for dispatch.
  ['101', 'accepted'],
  ['109', 'returned'],
  ['202', 'in_transit'],
  ['203', 'in_transit'],
  ['303', 'in_transit'],
  ['404', 'in_transit'],
  ['405', 'in_transit'],
  ['505', 'in_transit'],
  // Handed in at the sender's branch.
  ['606', 'accepted'],
  ['707', 'returned'],
  ['808', 'in_transit'],
  ['909', 'in_transit'],
  ['1011', 'in_transit'],
  ['11', 'in_transit'],
  ['12', 'in_transit'],
  ['1100', 'in_transit'],
  ['1200', 'ready_for_pickup'],
  // Arrived at the unit that delivers the parcel.
  ['1213', 'in_transit'],
  ['1214', 'ready_for_pickup'],
  ['1215', 'in_transit'],
  ['1216', 'ready_for_pickup'],
  // A reminder that the parcel still waits at the pickup point.
  ['1220', 'ready_for_pickup'],
  ['1315', 'out_for_delivery'],
  // Redirected: the parcel goes back to the sender.
  ['1521', 'returned'],
  // The recipient refused the parcel.
  ['1620', 'exception'],
  ['1621', 'failed_attempt'],
  ['1622', 'delivered'],
  ['1623', 'failed_attempt'],
  ['1624', 'failed_attempt'],
  ['1625', 'failed_attempt'],
  ['1626', 'failed_attempt'],
  ['1627', 'failed_attempt'],
  // Collected by the recipient at a branch.
  ['1724', 'delivered'],
  ['1825', 'returned'],
  // Lost.
  ['1927', 'exception'],
  ['2000', 'customs'],
  ['2220', 'in_transit'],
  ['2225', 'customs'],
  ['2226', 'in_transit'],
  ['2227', 'in_transit'],
  ['2230', 'customs'],
  // Handed from customs clearance to Meest's delivery network.
  ['2232', 'in_transit'],
  // Delivery suspended, usually at the sender's request.
  ['2331', 'exception'],
  // The suspension is lifted.
  ['2432', 'in_transit'],
  // The parcel did not arrive.
  ['5051', 'exception'],
  ['8081', 'in_transit'],
]);

/** Codes the map leaves without a stage on purpose. */
const QUIET: ReadonlyMap<string, string> = new Map([
  ['2533', "The recipient's details were corrected; it moves nothing."],
]);

/** A scan code: digits only. */
export const CODE = /^\d{1,6}$/;

/** The stage a scan code gives a parcel, if the map knows it. */
export function meestStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** The map reads the code alone: Meest words one code differently by source and language. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [...QUIET].map(([code, note]) => ({ code, note })),
};
