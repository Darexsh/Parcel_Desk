import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event codes APC's tracker gives its own scans and the partners' scans it
 * relays, in its own wording. The same code means the same thing whichever
 * partner delivers the parcel; the tracker files each code under one category,
 * which the comments name.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DR', 'registered'], // Data received: the sender created the label.
  ['50', 'accepted'], // Scanned at APC.
  ['911', 'in_transit'], // Ready for export at APC.
  ['912', 'in_transit'], // Departed APC's facility.
  ['914', 'in_transit'], // Arrived at an airport.
  ['915', 'in_transit'], // Departed an airport.
  ['01', 'in_transit'],
  ['04', 'in_transit'],
  ['09', 'in_transit'],
  ['21', 'in_transit'], // With the local carrier.
  ['30', 'in_transit'], // Arrived at an airport terminal.
  ['31', 'in_transit'],
  ['52', 'in_transit'], // On its way to the destination country.
  ['57', 'in_transit'], // Arrived at a local courier.
  ['64', 'in_transit'], // Arrived at a facility.
  ['317', 'in_transit'],
  ['02', 'customs'], // Customs inspection in progress.
  ['227', 'customs'],
  ['03', 'in_transit'], // Cleared customs: the parcel moves on.
  ['08', 'out_for_delivery'],
  ['17', 'ready_for_pickup'], // Ready for pickup at a collection point.
  ['11', 'delivered'],
  ['201', 'delivered'],
  ['214', 'delivered'],
]);

/** APC's own scans at its facilities, which it stamps in UTC. */
const OWN = new Set(['DR', '50', '911', '912']);

/** A code as the map keys it. */
export function apcCodeKey(code: string): string {
  return code.trim().toUpperCase();
}

/** The stage of an event code, or nothing for one the map leaves out or does not know. */
export function apcStage(code: string): Stage | undefined {
  return CODES.get(apcCodeKey(code));
}

/** Whether a code is one of APC's own facility scans. */
export function apcOwnScan(code: string): boolean {
  return OWN.has(apcCodeKey(code));
}

export const statusMap: CarrierStatusMap = {
  codeKey: apcCodeKey,
  stage: (code) => (code ? apcStage(code) : undefined),
  gaps: [
    { code: '340', note: 'Names the delivery partner\'s number for the parcel; it moves nothing.' },
  ],
};
