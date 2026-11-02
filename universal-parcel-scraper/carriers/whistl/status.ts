import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Parcelhub's tracking event list: each scan's sub category, the second status
 * column of Whistl's tracker, which Parcelhub publishes with its tracking API.
 * Whistl's own scans and those relayed from the carrier it hands a parcel to
 * share it. The scan's wording comes from Whistl or that carrier.
 *
 * A parcel at a collection point waits for its recipient; the recipient
 * collecting it delivers it. Parcelhub files a return parcel's scans under its
 * return sub categories, and a parcel sent back as returned to sender.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['shipment created', 'registered'],
  ['collected', 'accepted'],
  ['collected from customer', 'accepted'],
  ['with whistl', 'accepted'],
  ['in transit', 'in_transit'],
  ['arrived at collection depot', 'in_transit'],
  ['arrived at delivery depot', 'in_transit'],
  ['processed at hub', 'in_transit'],
  ['released to third party', 'in_transit'],
  ['resealed', 'in_transit'],
  ['handover to courier', 'in_transit'],
  ['handover to royalmail', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['with pod', 'delivered'],
  ['no pod', 'delivered'],
  ['left with neighbour', 'delivered'],
  ['left in a safe place', 'delivered'],
  ['customer collected', 'delivered'],
  ['delivered col. point', 'ready_for_pickup'],
  ['no-one to receive', 'failed_attempt'],
  ['held by customs', 'customs'],
  ['delayed', 'exception'],
  ['adverse weather', 'exception'],
  ['awaiting instruction', 'exception'],
  ['awaiting booking-in date', 'exception'],
  ['problem', 'exception'],
  ['bad address', 'exception'],
  ['item damaged', 'exception'],
  ['item hazardous', 'exception'],
  ['item prohibited', 'exception'],
  ['item overweight', 'exception'],
  ['item oversized', 'exception'],
  ['invalid service', 'exception'],
  ['recipient not known', 'exception'],
  ['refused', 'exception'],
  ['internal problem', 'exception'],
  ['collection failed', 'exception'],
  ['rejected', 'exception'],
  ['undeliverable', 'exception'],
  ['lost', 'exception'],
  ['loss', 'exception'],
  ['damage', 'exception'],
  ['shipment deleted', 'exception'],
  ['returned to sender', 'returned'],
  ['return processed at hub', 'returned'],
  ['return - in transit', 'returned'],
  ['return - customer drop to store', 'returned'],
  ['return - collect from home', 'returned'],
  ['return - delivered', 'returned'],
]);

/**
 * Sub categories that move nothing: notes on the record, the sender's or
 * Parcelhub's own actions and claim advice. They read as pending, and a parcel
 * keeps the stage of the scan before them.
 */
const QUIET: ReadonlyMap<string, string> = new Map([
  ['information', 'A note on the record, such as a weight Whistl captured or a new final-mile number; it moves nothing.'],
  ['item weight changed', 'Whistl weighed the parcel again; it moves nothing.'],
  ['tracking status overdue', 'Parcelhub noticed that no scan came in time; it moves nothing.'],
  ['part delivered', 'Part of a consignment of several parcels arrived; it does not say whether this one did.'],
  ['recipient will collect', 'The recipient chose to collect the parcel; it does not say that the parcel waits anywhere.'],
  ['delayed by request', 'The delivery waits at someone’s request; it moves nothing.'],
  ['customer action', 'A request by the sender or the recipient; it moves nothing.'],
  ['reroute requested', 'A request to send the parcel elsewhere; it moves nothing until a scan follows.'],
  ['recall requested', 'The sender asked for the parcel back; it moves nothing until a scan follows.'],
  ['pod requested', 'The sender asked for proof of delivery; it moves nothing.'],
  ['claim submitted', 'The sender claimed for the parcel; it moves nothing.'],
  ['label reprinted', 'The sender printed the label again; it moves nothing.'],
  ['assigned to customer services', 'Parcelhub’s customer services took the case; it moves nothing.'],
  ['disputed delivery', 'Advice to claim for a delivery the recipient disputes; it moves nothing.'],
  ['non-compliance', 'Advice to claim because the parcel did not meet the service’s terms; it moves nothing.'],
  ['carriage', 'Advice to claim the carriage charge back; it moves nothing.'],
  ['advised to claim - delayed', 'Advice to claim for a late delivery; it moves nothing.'],
]);

/** The key the map reads: the sub category in lower case, as Parcelhub capitalizes some twice. */
const keyOf = (code: string) => code.trim().toLocaleLowerCase('en-GB').split(/\s+/).join(' ');

/** The stage the map gives a Parcelhub sub category, if it gives one. */
export function whistlCodeStage(code: string): Stage | undefined {
  return STAGES.get(keyOf(code));
}

/** Whether a sub category moves nothing, so the parcel keeps the stage of the scan before it. */
export function whistlQuiet(code: string): boolean {
  return QUIET.has(keyOf(code));
}

/** The stage the map gives a Parcelhub sub category: a quiet one is pending. */
function mappedStage(code: string): Stage | undefined {
  return whistlCodeStage(code) ?? (whistlQuiet(code) ? 'pending' : undefined);
}

/**
 * A scan's stage from its sub category, else from the shared wording rules for
 * a sub category the list does not have.
 */
export function whistlStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = mappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: keyOf,
  stage: (code) => (code ? mappedStage(code) : undefined),
  gaps: [],
};
