import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Vasp Expresso's event types, the reply's `eventTypeId`. Types seen in
 * replies are mapped, and so are the Kios steps of the page's progress rails,
 * which name them. Another type falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Created in the system; returns use it for a return booked at a Kios store too.
  ['7', 'out_for_delivery'], // Loaded in the delivery vehicle; the rails call it "Em distribuição".
  ['10', 'in_transit'], // At a depot.
  ['12', 'ready_for_pickup'], // At the Kios store the recipient collects from.
  ['13', 'accepted'], // Left at a Kios store by the sender, the first step of that rail.
  ['14', 'delivered'], // Collected from the Kios store, the last step of that rail.
  ['18', 'delivered'], // Delivered to the customer.
  ['22', 'failed_attempt'], // A round that did not deliver; the incidence gives the reason, such as an absent recipient.
  ['41', 'exception'], // A problem at the depot, such as a parcel set aside after a failed round.
  ['48', 'accepted'], // Collected from the sender.
]);

/**
 * A new delivery day (37), set after a failed round and sometimes before the
 * first, and the recipient's own requests through Track My Parcel (42, 43),
 * move nothing.
 */
const NOTICES = new Set(['37', '42', '43']);

/** The stage Vasp Expresso's event types give a scan. */
export function vaspExpressoMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its event type, else the shared wording rules, else nothing. */
export function vaspExpressoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = vaspExpressoMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? vaspExpressoMappedStage(code) : undefined),
  gaps: [
    { code: '37', note: 'A new delivery day, set after a failed round and sometimes before the first; it moves nothing.' },
    { code: '42', note: 'The recipient changed the address through Track My Parcel; it moves nothing.' },
    { code: '43', note: 'The recipient chose a new delivery day through Track My Parcel; it moves nothing.' },
  ],
};
