import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Pilot's event codes, from the event status table of its tracking API
 * documentation and from replies. The table sorts each code into a type:
 * general (`GEN`), home delivery (`HD`) or exception (`EXC`). Replies word
 * the codes with Maersk's name where the table has Pilot's.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['NEW', 'registered'], // The shipper sent the shipment's details.
  ['XML', 'registered'], // The same, sent electronically.
  ['IIB', 'registered'], // An air or ocean booking was opened.
  ['PUA', 'registered'],
  ['IWP', 'registered'],
  ['WPP', 'registered'], // Replies give this code for the table's waiting for pickup.
  ['PU', 'accepted'],
  ['ALR', 'in_transit'],
  ['REV', 'in_transit'],
  ['RNH', 'in_transit'],
  ['DNH', 'in_transit'],
  ['RAD', 'in_transit'], // Arrived at another carrier's terminal, seen in replies.
  ['RAG', 'in_transit'], // Recovered at the destination by a partner agent.
  ['TRN', 'in_transit'], // Handed to a partner agent for delivery beyond Pilot's network.
  ['THD', 'in_transit'], // Handed to a home delivery agent at the destination.
  ['DRA', 'in_transit'],
  ['ING', 'in_transit'], // On the way to an export gateway.
  ['COB', 'in_transit'],
  ['SLD', 'in_transit'],
  ['TSP', 'in_transit'],
  ['TDP', 'in_transit'],
  ['ARP', 'in_transit'],
  // Delays the table files as general events, not exceptions.
  ['BRD', 'in_transit'],
  ['TSD', 'in_transit'],
  ['VSD', 'in_transit'],
  ['IBN', 'customs'],
  ['DTB', 'customs'],
  ['IDR', 'customs'], // The documents were recovered; the freight has not cleared customs.
  ['ICC', 'customs'],
  ['CEH', 'customs'],
  ['IRS', 'in_transit'], // Released from customs, which puts the shipment back in transit.
  ['SRC', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['DHC', 'ready_for_pickup'], // Held at the destination terminal for the consignee to collect.
  ['DEL', 'delivered'],
  ['EXC1', 'failed_attempt'],
  ['EXC2', 'failed_attempt'],
  ['EXC5', 'exception'],
  ['EXC6', 'exception'],
  ['EXC7', 'exception'],
  ['EXC8', 'exception'],
  ['EXC10', 'exception'],
  ['EXC13', 'exception'],
  ['EXC15', 'exception'],
  ['EXC16', 'exception'],
  ['EXC17', 'exception'],
  ['EXC21', 'exception'],
  ['EXC24', 'exception'],
  ['DLY', 'exception'],
  ['NSH', 'exception'],
  ['RSH', 'exception'], // Recovered at the destination with pieces missing.
  ['XXX', 'exception'], // The order or the shipment was cancelled.
]);

// Appointments, scheduling and the calls and messages that arrange them, and an
// updated booking: they move nothing.
const UNSTAGED = new Set(['APT', 'DAP', 'IDS', 'PRE', 'PRE1', 'CON1', 'CON2', 'CTC', 'IUB']);

/** The stage Pilot's codes give an event code. */
export function pilotMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/**
 * An event's stage: its code; else, for a code the table files as an
 * exception, an exception; else the shared wording rules; else nothing.
 */
export function pilotStage(code: string, type: string, wording: string): ClassifiedWording | null {
  const mapped = pilotMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.toUpperCase())) return null;
  if (type.toUpperCase() === 'EXC') return { stage: 'exception', source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? pilotMappedStage(code) : undefined),
  gaps: [
    { code: 'APT', note: 'A delivery appointment was made, often when the shipment is booked; the tracking page passes over it for the status.' },
    { code: 'DAP', note: 'A delivery appointment was made; it moves nothing.' },
    { code: 'IDS', note: 'A delivery was scheduled; it moves nothing.' },
    { code: 'PRE', note: 'A call to the consignee before the delivery; it moves nothing.' },
    { code: 'PRE1', note: 'An e-mail to the consignee before the delivery; it moves nothing.' },
    { code: 'CON1', note: 'A call to the consignee to arrange the delivery went unanswered; it moves nothing.' },
    { code: 'CON2', note: 'A message was left for the consignee to arrange the delivery; it moves nothing.' },
    { code: 'CTC', note: 'Pilot waits for the consignee to answer about the delivery; it moves nothing.' },
    { code: 'IUB', note: 'An air or ocean booking was updated; it moves nothing.' },
  ],
};
