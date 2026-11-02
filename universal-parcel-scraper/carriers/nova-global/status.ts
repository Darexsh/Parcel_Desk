import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Nova Global's scan codes, the same whatever the reply's language. Only codes
 * seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1-0', 'registered'], // The order for delivery to the destination country.
  ['1-2', 'accepted'], // A parcel that reached the hub without an order is processed there.
  ['14', 'accepted'],
  ['20', 'customs'], // Delivered to the customs terminal.
  ['22', 'in_transit'], // Left the customs terminal.
  ['23', 'in_transit'], // Arrived at a transit sorting centre.
  ['24', 'in_transit'], // Arrived in a country under customs control, on its way through.
  ['24-1', 'in_transit'], // In transit through Ukraine.
  ['25', 'in_transit'], // Left a country under customs control.
  ['26', 'in_transit'], // Left a transit sorting centre.
  ['30', 'in_transit'], // Sent to the destination city.
  ['301', 'in_transit'], // At the terminal of the destination city.
  ['303', 'ready_for_pickup'], // In a parcel locker, for the recipient to collect.
  ['37', 'out_for_delivery'],
  ['38', 'ready_for_pickup'], // At the branch, for the recipient to collect.
  ['3-1', 'delivered'],
  ['400', 'customs'], // Customs declaration under way.
  ['401', 'in_transit'], // Customs declaration finished: the parcel is cleared.
  ['402', 'customs'], // The parcel needs customs clearance.
  ['407', 'customs'], // Documents submitted for customs clearance.
  ['407-1', 'customs'],
  ['410', 'customs'], // The documents customs asked for arrived.
  ['54', 'in_transit'], // A truck left for its destination.
  ['55', 'in_transit'], // A truck reached its destination.
  ['553', 'exception'], // Lost.
  ['63-4', 'in_transit'], // Released from the hub's area for parcels without an order.
  ['76', 'in_transit'], // The consignment reached the airport.
  ['247', 'in_transit'], // Processed and ready for the flight.
]);

/** The stage Nova Global's codes give a scan code. */
export function novaGlobalMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function novaGlobalStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = novaGlobalMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? novaGlobalMappedStage(code) : undefined),
  gaps: [],
};
