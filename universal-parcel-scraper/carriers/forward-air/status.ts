import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Forward Air's status codes, as its tracking lookup gives them with each
 * scan. Freight goes station to station; a pickup and a delivery to the door
 * are extra services with their own codes. Only codes seen in replies are
 * mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ACK', 'registered'], // The booking is confirmed.
  ['DPUP', 'registered'], // A driver is sent to collect the freight.
  ['PARR', 'registered'], // The driver reached the shipper.
  ['PUP', 'accepted'], // The driver collected the freight.
  ['RCV', 'accepted'], // Received at the origin station.
  ['TND', 'accepted'], // Tendered at the origin station, before it leaves.
  ['DEP', 'in_transit'], // Departed a station.
  ['ARR', 'in_transit'], // Arrived at a station on the way.
  ['ARRD', 'in_transit'], // Arrived at the destination station.
  ['OUTDV', 'out_for_delivery'],
  ['DARR', 'out_for_delivery'], // The driver reached the consignee.
  ['DLV', 'delivered'],
  // Recovered: the consignee collected the freight at the destination station,
  // which ends a station-to-station shipment and dates its proof of delivery.
  ['COMP', 'delivered'],
  ['CAN', 'exception'], // The shipment was cancelled.
]);

// Billing after the freight stopped moving.
const INVOICED = 'INVC';

/** The stage Forward Air's codes give a scan code. */
export function forwardAirMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function forwardAirStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = forwardAirMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code.toUpperCase() === INVOICED) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? forwardAirMappedStage(code) : undefined),
  gaps: [
    { code: INVOICED, note: 'The shipment was invoiced after its last movement; it moves nothing.' },
  ],
};
