import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Each row of Fastbox's tracker has a status tag beside its wording. Fastbox's
 * own steps, before it hands the parcel to its partner, are known by their tag
 * alone. A partner's rows carry tracking-platform tags ("InTransit",
 * "InfoReceived") over the partner's own wording, which tells more: their
 * wording is staged first, by the shared rules, and the tag stages the rest.
 */
const TAGS: ReadonlyMap<string, Stage> = new Map([
  // The order, at Fastbox's warehouse before the parcel ships ("Order Accepted").
  ['Shipping soon', 'registered'],
  // Processed at Fastbox's warehouse for its international shipping.
  ['Ready for International shipping', 'accepted'],
  // Handed to the partner that carries it abroad, often Korea Post's EMS.
  ['International Shipping', 'in_transit'],
  // A partner's advance data, as the destination post's "Item Booked".
  ['InfoReceived', 'registered'],
  ['InTransit', 'in_transit'],
  ['OutForDelivery', 'out_for_delivery'],
]);

// The tags of Fastbox's own steps, whose wording is Fastbox's too.
const OWN_TAGS = new Set(['Shipping soon', 'Ready for International shipping', 'International Shipping']);

/** The stage a row's tag gives it. */
export function fastboxMappedStage(tag: string): Stage | undefined {
  return TAGS.get(tag.trim());
}

/** A row's stage: Fastbox's own steps by their tag, a partner's by its wording, else by the tag. */
export function fastboxStage(tag: string, wording: string): ClassifiedWording | null {
  const mapped = fastboxMappedStage(tag);
  if (mapped && OWN_TAGS.has(tag.trim())) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  if (worded.source !== 'none') return worded;
  return mapped ? { stage: mapped, source: 'carrier_map' } : null;
}

/** What the map says about one row, by its tag. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? fastboxMappedStage(code) : undefined),
  gaps: [],
};
