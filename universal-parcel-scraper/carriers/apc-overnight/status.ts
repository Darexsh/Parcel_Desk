import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of APC's tracking page: each item's journey through the
 * network, then the delivery records the delivering depot keeps for the
 * consignment. The rows carry no code.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The sending depot collected the consignment and scanned it in.
  ['at sending depot', 'accepted'],
  ['at hub', 'in_transit'],
  ['at delivery depot', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // Nobody was in, and the driver left a "Sorry we missed you" card.
  ['carded', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['returned to sender', 'returned'],
]);

// A delivery the recipient moved to another day or option, not a movement:
// the consignment keeps the stage it had.
const NOTICES = new Set(['delivery rearranged by customer']);

/** The stage the map gives APC's wording, if it knows it. */
export function apcOvernightScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export function isApcOvernightNotice(wording: string): boolean {
  return NOTICES.has(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function apcOvernightStage(wording: string): ClassifiedWording | null {
  const mapped = apcOvernightScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : apcOvernightScanStage(wording)),
  gaps: [...NOTICES].map(wording => ({ wording, note: 'A delivery moved by the recipient, not a movement: the consignment keeps the stage it had.' })),
};
