import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * ArcBest's tracker sends no status codes, only wording: the shipment's
 * current status and the titles of its progress rail, which share one
 * vocabulary, and the labels the page gives the pickup. A shipment at its
 * destination service center is still in transit; the delivery run starts
 * with "Out For Delivery".
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'pickup requested': 'registered',
  'awaiting pickup': 'registered',
  'picked up': 'accepted',
  'pickup stop completed': 'accepted',
  'in transit': 'in_transit',
  'transit complete': 'in_transit',
  'at destination service center': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
};

/** The stage the map gives a status or rail title, if it knows the wording. */
export function abfWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(WORDINGS, normalized) ? WORDINGS[normalized] : undefined;
}

/**
 * The stage of the shipment's status: ArcBest's wording, then the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function abfStage(wording: string): ClassifiedWording | null {
  const mapped = abfWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status, by its wording: ArcBest sends no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : abfWordingStage(wording)),
  gaps: [],
};
