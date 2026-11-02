import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Jersey Post's tracker, for its own scans and those it relays
 * from the post abroad. The reply's status codes are 1 on every scan, delivered
 * or not, so only the wording is read. A failed delivery can add the reason
 * after a dash ("Unsuccessful Delivery Attempt - Incorrect/illegible/incomplete
 * address"); the wording before it gives the stage.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // It can come twice, days apart, before the item is despatched.
  ['awaiting item from sender', 'registered'],
  ['outbound item despatched', 'in_transit'],
  ['arrived at international distribution centre', 'in_transit'],
  ['item assigned to flight', 'in_transit'],
  ['departed international distribution centre', 'in_transit'],
  ['bag received in destination country', 'in_transit'],
  // The destination post's office of exchange, not an acceptance.
  ['item received at inbound office of exchange', 'in_transit'],
  ['item received', 'in_transit'],
  ['item held by customs', 'customs'],
  // On its way from the office of exchange; in the histories seen, a delivery attempt came after it.
  ['item being sent to customer', 'in_transit'],
  ['unsuccessful delivery attempt', 'failed_attempt'],
  ['item available for collection by customer', 'ready_for_pickup'],
  ['item delivered to customer', 'delivered'],
]);

/** The stage the map gives a wording in `normalizeStatusWording` form, with or without a reason after a dash. */
export function jerseyPostMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.get(normalized) ?? STAGES.get(normalized.split(' - ', 1)[0]!.trim());
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function jerseyPostStage(wording: string): ClassifiedWording | null {
  const mapped = jerseyPostMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jerseyPostMappedStage(wording),
  gaps: [],
};
