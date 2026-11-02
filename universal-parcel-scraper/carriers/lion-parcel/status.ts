import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Lion Parcel's status codes, which each scan and the shipment's summary
 * carry. The tracker's own table groups them into a few summaries; the
 * groups are coarse (arrival at the destination warehouse and customs sit
 * with out for delivery, a claim with returns), so the codes are staged by
 * what their scans say. Pickup codes a scan never showed fall to the wording.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // Booked online, before a courier collects the parcel or an agent takes it in.
  ['SHPCRT', 'registered'], // Shipment created.
  ['SHPSCD', 'registered'], // Pickup scheduled.
  ['CRRSRC', 'registered'], // Looking for a courier to collect it.
  ['CRROTW', 'registered'], // A courier is on the way to collect it.
  ['CRRNFD', 'registered'], // Looking for another courier to collect it.
  ['BKD', 'accepted'], // Taken in by a Lion Parcel agent.
  ['PUP', 'in_transit'], // On its way from the agent to a warehouse.
  ['STI-SC', 'in_transit'], // At a transit warehouse.
  ['STO-SC', 'in_transit'], // Collected from a transit warehouse by the shuttle.
  ['STI', 'in_transit'], // At a Lion Parcel warehouse.
  ['BAGGING', 'in_transit'],
  ['CARGO TRUCK', 'in_transit'], // Waiting to leave by truck.
  ['CARGO PLANE', 'in_transit'], // Waiting to fly, repeated each day until it does.
  ['CARGO TRAIN', 'in_transit'],
  ['CARGO SHIP', 'in_transit'],
  ['PICKUP_TRUCKING', 'in_transit'], // Left by truck.
  ['TRANSIT', 'in_transit'], // In transit at a hub city.
  ['INT-STI', 'in_transit'],
  ['STI-DEST', 'in_transit'], // At the destination's warehouse.
  ['STI DEST-SC', 'in_transit'],
  ['OCC-HAL', 'customs'], // Held at customs abroad.
  ['OCC-EXP', 'customs'], // Export clearance.
  ['OCC-IMP', 'customs'], // Import clearance.
  ['DEL', 'out_for_delivery'],
  ['DEX', 'failed_attempt'],
  ['POD', 'delivered'],
  ['STT ADJUSTED POD', 'delivered'],
  ['RTS', 'returned'],
  // The carrier the parcel was booked on refused it, as for an X-ray check it
  // failed; it is moved to another one or cancelled.
  ['REJECTED', 'exception'],
  ['CLAIM', 'exception'], // A claim for a lost or damaged parcel.
  ['NOT RECEIVED', 'exception'],
  ['DAMAGED', 'exception'],
  ['MISSING', 'exception'],
  // Cancelled by the courier, the customer, for payment, by an admin, on expiry, or scrapped.
  ['CNX', 'exception'],
  ['CRRCNC', 'exception'],
  ['CSTCNC', 'exception'],
  ['PAYCNC', 'exception'],
  ['ADPCNC', 'exception'],
  ['ADMCNC', 'exception'],
  ['EXPCNC', 'exception'],
  ['SCRAP', 'exception'],
]);

/** The stage Lion Parcel's code gives a scan or a summary. */
export function lionParcelMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

// A price adjustment for the parcel's weight and volume moves nothing.
const NOTICES = new Set(['STT ADJUSTED']);

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function lionParcelStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = lionParcelMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? lionParcelMappedStage(code) : undefined),
  gaps: [
    { code: 'STT ADJUSTED', note: 'A price adjustment for the parcel\'s weight and volume; it moves nothing.' },
  ],
};
