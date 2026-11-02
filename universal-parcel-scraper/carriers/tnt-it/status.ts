import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * tnt.it's scan codes (`StatusCode`). The wording is Italian prose; the code
 * decides. Only codes seen in replies are mapped; another code has no stage.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // Booked, not yet handed to FedEx: the only scan of a shipment that has not moved.
  ['0', 'registered'],
  ['P', 'accepted'], // Left at a FedEx Location for the courier to collect.
  ['07', 'in_transit'], // Left the origin depot.
  ['12', 'in_transit'],
  ['14', 'out_for_delivery'],
  // Held at the destination depot for collection.
  ['20', 'ready_for_pickup'],
  // The destination depot is behind and did not take the parcel out: a delay, not an attempt.
  ['65', 'in_transit'],
  ['90', 'delivered'],
]);

/** The stage tnt.it's code gives a scan. */
export function tntItalyStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? tntItalyStage(code) : undefined),
  gaps: [{
    code: '13',
    note: 'The delivery the recipient agreed with TNT, still to come: not a scan, so the parcel keeps the stage it had.',
  }],
};
