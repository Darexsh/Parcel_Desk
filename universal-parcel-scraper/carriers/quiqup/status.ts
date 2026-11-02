import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Quiqup's order states, which its tracker records with the moment the order
 * entered each one. The page script names them all; another state falls to
 * the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['pending', 'registered'], // The merchant booked the order.
  ['scheduled', 'registered'], // Booked for a later day.
  ['processing', 'registered'], // An order Quiqup fulfils from its own warehouse, being prepared there.
  ['picking_started', 'registered'], // Being picked in Quiqup's warehouse.
  ['ready_for_collection', 'registered'], // Ready for the courier at the merchant's or the warehouse.
  ['out_for_collection', 'registered'], // A courier is on the way to collect it.
  ['collected', 'accepted'],
  ['received_at_depot', 'in_transit'],
  // At the depot, on its way out or back after a missed delivery.
  ['at_depot', 'in_transit'],
  ['in_transit', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['delivery_failed', 'failed_attempt'],
  ['delivery_complete', 'delivered'],
  // Held, which the page shows with a link to customer service.
  ['on_hold', 'exception'],
  ['cancelled', 'exception'],
  // On the way back to the merchant, and back there; the page shows both as cancelled.
  ['return_to_origin', 'returned'],
  ['returned_to_origin', 'returned'],
]);

const GAPS = [
  { code: 'collection_failed', note: 'The courier could not collect the parcel from the merchant, or a return from the customer; the parcel has not moved.' },
  { code: 'out_for_return', note: 'Named only for a customer\'s return the courier collects, without saying which leg of the return it starts.' },
] as const;
const UNSTAGED: ReadonlySet<string> = new Set(GAPS.map((gap) => gap.code));

/** A state as the reply names it, in words: `at_depot` reads "At depot". */
export function quiqupWording(state: string): string {
  const words = state.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The stage Quiqup's states give a state alone. */
export function quiqupMappedStage(state: string): Stage | undefined {
  return CODES.get(state.toLowerCase());
}

/** A state's stage: its own, else the shared wording rules, else nothing. */
export function quiqupStage(state: string): ClassifiedWording | null {
  const mapped = quiqupMappedStage(state);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(state.toLowerCase())) return null;
  const worded = classifyWording(quiqupWording(state), 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? quiqupMappedStage(code) : undefined),
  gaps: GAPS,
};
