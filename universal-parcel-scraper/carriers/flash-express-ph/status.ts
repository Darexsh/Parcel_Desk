import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { flashExpressMappedStage, flashExpressStage, statusMap as flashExpressStatusMap } from '../flash-express/status.js';

/**
 * Scan `route_action` codes the Philippine tracker uses beyond those of Flash
 * Express in Thailand, whose map covers the rest: both run on Flash's
 * platform and share its codes.
 */
const ACTIONS: ReadonlyMap<string, Stage> = new Map([
  ['PENDING_RETURN', 'returned'], // The parcel goes back to its sender, under a return waybill.
  ['DEPARTURE_GOODS_VAN_CK_SCAN', 'in_transit'], // Loaded on a linehaul van that leaves.
  ['ARRIVAL_GOODS_VAN_CHECK_SCAN', 'in_transit'], // Off a linehaul van that arrived.
]);
// A delivery the wording makes the end of the trip back: the sender or seller took the parcel.
const BACK_TO_SENDER = /\b(?:to|by)\s+(?:the\s+)?(?:sender|seller)\b/i;
/** Wording the tracker sends without a code, for the scans of some parcels. */
const UNCODED: ReadonlyMap<string, Stage> = new Map([
  ['successful pick up', 'accepted'],
  ['parcel received by origin outlet', 'accepted'],
  ['parcel outbound to next station', 'in_transit'],
  ['parcel arrived at outlet', 'in_transit'],
]);

/** Wording that came without a code and moves nothing. */
const WORDING_GAPS = [
  { wording: 'sender not at pickup location', note: 'A courier came to pick the parcel up and the sender was not there; nothing was handed over.' },
] as const;
const UNCODED_GAPS = new Set<string>(WORDING_GAPS.map((gap) => gap.wording));

/** The stage the codes, or the wording sent without one, give a scan, with the return's delivery to its sender as a return. */
export function flashExpressPhMappedStage(code: string, wording: string): Stage | undefined {
  if (!code) return UNCODED.get(normalizeStatusWording(wording));
  const mapped = ACTIONS.get(code) ?? flashExpressMappedStage(code);
  return mapped === 'delivered' && BACK_TO_SENDER.test(wording) ? 'returned' : mapped;
}

/** A scan's stage: its code or known wording, else the shared wording rules, else nothing. */
export function flashExpressPhStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = flashExpressPhMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!code && UNCODED_GAPS.has(normalizeStatusWording(wording))) return null;
  return flashExpressStage(code, wording);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => flashExpressPhMappedStage(code ?? '', wording),
  gaps: [...flashExpressStatusMap.gaps, ...WORDING_GAPS],
};
