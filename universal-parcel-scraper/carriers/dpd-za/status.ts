import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * DPD South Africa's tracking event types, the reply's `trackingEventTypeId`.
 * Only types seen in replies are mapped; another type falls to the wording
 * rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['52', 'registered'], // Waybill imported: DPD has been told of the parcel but does not have it yet.
  ['32', 'registered'], // Collection imported: a collection from the sender is booked.
  ['27', 'accepted'], // Collection completed; it can be recorded after the parcel has left the depot.
  ['9', 'accepted'], // Taken in at the sender's own premises.
  ['1', 'in_transit'], // Scanned into a depot, the collecting or the delivering one.
  ['30', 'in_transit'], // Debriefed: processed at the depot after a collection round.
  ['49', 'in_transit'], // Measured and weighed at the depot.
  ['26', 'in_transit'], // Dispatched on a linehaul manifest to another depot.
  ['14', 'in_transit'], // The manifest arrived; it can be recorded after the delivery.
  ['34', 'in_transit'], // The manifest was unloaded at the depot.
  ['3', 'out_for_delivery'],
  ['5', 'failed_attempt'], // A round that did not deliver; the parcel goes out again.
  ['8', 'delivered'],
  ['4', 'delivered'], // The proof of delivery received, repeated as it is processed.
  ['64', 'delivered'], // The proof-of-delivery image taken on the driver's device, after the delivery.
]);

// A delivery day booked with the recipient is still to come, so it moves nothing.
const NOTICES = new Set(['48']);

/**
 * The stage the page's progress rail gives the summary's `opsStatusId`: the
 * page lights Received, In transit, At depot, On delivery and Delivered from
 * it, and shows Exception in place of the rail for 1, 35 and 43.
 */
const RAIL: ReadonlyMap<number, Stage> = new Map([
  [4, 'accepted'],
  [13, 'in_transit'],
  [5, 'in_transit'],
  [9, 'in_transit'],
  [18, 'in_transit'],
  [17, 'out_for_delivery'],
  [21, 'delivered'],
  [1, 'exception'],
  [35, 'exception'],
  [43, 'exception'],
]);

/** The stage DPD South Africa's event types give a scan. */
export function dpdZaMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The stage the page's progress rail shows for the waybill's operational status. */
export function dpdZaRailStage(opsStatusId: number): Stage | undefined {
  return RAIL.get(opsStatusId);
}

/** A scan's stage: its event type, else the shared wording rules, else nothing. */
export function dpdZaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = dpdZaMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? dpdZaMappedStage(code) : undefined),
  gaps: [
    { code: '48', note: 'A delivery day booked with the recipient, which is still to come; it moves nothing.' },
  ],
};
