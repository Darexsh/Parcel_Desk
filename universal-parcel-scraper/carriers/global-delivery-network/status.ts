import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GDN's wording the shared rules read otherwise. Its tracker relays its
 * partners' scans beside its own, all as wording without codes.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(Object.entries({
  'With courier for delivery': 'out_for_delivery',
  // At the delivery depot, waiting for the courier's round.
  'Ready for courier': 'in_transit',
  'Parcel received in outbound hub for processing': 'accepted',
  'Exported to International Processing Hub': 'in_transit',
  'Enroute to International Processing Hub': 'in_transit',
  // The label number of the partner that carries it abroad, not a movement.
  'Tracking number allocated to parcel': 'registered',
} satisfies Record<string, Stage>).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// "Handed over to NZ Post": a partner takes it on the way, long after GDN accepted it.
const HANDED_OVER = /^handed over to \S/;

function stageOf(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (HANDED_OVER.test(wording) ? 'in_transit' : undefined);
}

/** The stage GDN's own wording gives a scan, if the map has one. */
export function gdnStage(wording: string): Stage | undefined {
  return stageOf(normalizeStatusWording(wording));
}

/** The tracker's scans carry wording and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : stageOf(wording),
  gaps: [],
};
