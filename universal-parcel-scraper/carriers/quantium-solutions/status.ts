import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestones of Quantium's tracker, which carries no codes. Each scan has
 * a milestone and, for the scans its partners relay, a remark naming the
 * partner's own milestone, which can be finer: a scan the tracker files as
 * "IN TRANSIT" can be the start of customs clearance. Only wordings seen on
 * the tracker are mapped; another falls to the wording rules.
 */
const MILESTONES: ReadonlyMap<string, Stage> = new Map(([
  // The shipper's order, before Quantium has the parcel.
  ['Shipment created', 'registered'],
  ['Shipment received', 'accepted'],
  ['Shipment under processing at origin hub', 'in_transit'],
  ['Shipment despatched to transshipment hub', 'in_transit'],
  ['DEPART ORIGIN', 'in_transit'],
  ['Shipment received at transshipment hub', 'in_transit'],
  ['Shipment despatched to overseas', 'in_transit'],
  ['READY FOR DEPARTURE', 'in_transit'],
  ['FLIGHT DEPARTURE TO DESTINATION', 'in_transit'],
  ['Shipment arrived at destination port', 'in_transit'],
  // Released by customs, which sends the parcel on.
  ['Shipment released from customs/ government check point', 'in_transit'],
  ['Shipment received at delivery branch', 'in_transit'],
  ['IN TRANSIT', 'in_transit'],
  ['Shipment out for delivery', 'out_for_delivery'],
  ['Shipment delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The partners' milestones the remarks name, where they say more than the tracker's own. */
const REMARKS: ReadonlyMap<string, Stage> = new Map(([
  ['Depart Origin', 'in_transit'],
  ['Arrive Hub', 'in_transit'],
  ['Depart Hub', 'in_transit'],
  ['Ready for Departure', 'in_transit'],
  ['Flight Departure to Destination', 'in_transit'],
  ['Arrive Destination', 'in_transit'],
  ['Customs Clearance Begins', 'customs'],
  ['Customs Cleared', 'in_transit'],
  ['Handed Over for Delivery', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// The tracker's catch-all milestone, under which a remark decides.
const GENERIC = new Set([normalizeStatusWording('IN TRANSIT')]);

/** The stage the map gives a milestone and its remark, if it knows them. */
export function quantiumMappedStage(milestone: string, remark: string): Stage | undefined {
  const own = normalizeStatusWording(milestone);
  const note = normalizeStatusWording(remark);
  const remarked = note ? REMARKS.get(note) : undefined;
  if (remarked) return remarked;
  // A remark the map does not know leaves the catch-all milestone open.
  if (note && GENERIC.has(own)) return undefined;
  return MILESTONES.get(own);
}

/**
 * A scan's stage: its milestone and remark, else the wording rules on the
 * remark, else the catch-all milestone, else the wording rules on the
 * milestone, else nothing, which keeps it visible for review.
 */
export function quantiumStage(milestone: string, remark: string): ClassifiedWording | null {
  const mapped = quantiumMappedStage(milestone, remark);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (remark) {
    const worded = classifyWording(remark, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  const own = MILESTONES.get(normalizeStatusWording(milestone));
  if (own) return { stage: own, source: 'carrier_map' };
  if (!milestone) return null;
  const worded = classifyWording(milestone, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The stage of a scan's wording as the adapter writes it: the milestone, then
 * the remark after a colon when it says more.
 */
export function quantiumWordingStage(wording: string): Stage | undefined {
  const at = wording.indexOf(': ');
  if (at >= 0) return quantiumMappedStage(wording.slice(0, at), wording.slice(at + 2));
  // A scan with a remark alone is worded by its remark.
  const own = normalizeStatusWording(wording);
  return MILESTONES.get(own) ?? REMARKS.get(own);
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => quantiumWordingStage(wording),
  gaps: [],
};
