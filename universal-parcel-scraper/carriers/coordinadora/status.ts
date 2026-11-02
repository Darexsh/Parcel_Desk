import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Coordinadora's codes. A guide's states are one digit, the steps of the
 * tracker's rail; its incidents (novedades) are three digits, so the two never
 * share a code. Only codes seen in replies are mapped; another code falls to
 * the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // The guide exists; Coordinadora has not received the parcel.
  ['2', 'accepted'], // At the origin terminal.
  ['3', 'in_transit'],
  ['4', 'in_transit'], // At the destination terminal.
  ['5', 'out_for_delivery'],
  ['6', 'delivered'],
  ['8', 'exception'], // Closed by an incident; the tracker names a new guide when one was made.
  ['9', 'ready_for_pickup'], // Waiting at a Droop pickup point.
  ['100', 'exception'], // A unit missing in Coordinadora's handling.
  ['400', 'exception'], // Units Coordinadora cannot trace.
  ['402', 'exception'], // Units not located or not sent.
  ['602', 'exception'], // Held for a security check.
  ['699', 'exception'], // The address is incomplete.
  ['701', 'failed_attempt'], // A visit that did not deliver.
  ['702', 'failed_attempt'], // The courier did not find the address.
  ['703', 'failed_attempt'], // Nobody at the address knows the recipient.
  ['734', 'exception'], // The unit is at another terminal than the destination's.
]);

// A delay on a national route, and the notice that a delay will not stop the
// delivery: the parcel moves on.
const DELAYS = new Set(['500', '733']);

/** The stage Coordinadora's codes give a state or incident. */
export function coordinadoraMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A state's or incident's stage: its code, else the shared wording rules, else nothing. */
export function coordinadoraStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = coordinadoraMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (DELAYS.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? coordinadoraMappedStage(code) : undefined),
  gaps: [
    { code: '0', note: 'Not a scan: the only state of a guide Coordinadora does not know, read as not found.' },
    { code: '500', note: 'A delay on a national route; the parcel moves on.' },
    { code: '733', note: 'A notice that the delivery will take longer and the guide stays in distribution; it moves nothing.' },
  ],
};
