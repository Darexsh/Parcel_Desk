import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * BJS's order statuses, in English without a code: the steps of the tracker's
 * progress bar and the order states its page script words. An order goes from
 * the retailer's release to BJS, through BJS's warehouse and a booked delivery
 * day, to a two-person crew.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['released', 'registered'],
  // Waiting for the goods or for a delivery day; neither moves them yet.
  ['outstanding', 'registered'],
  ['received', 'accepted'],
  ['scheduled', 'in_transit'],
  ['confirmed', 'in_transit'],
  ['en route', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['completed', 'delivered'],
  // The page then says the delivery was attempted on a day.
  ['failed', 'failed_attempt'],
  // Held until the retailer says what to do.
  ['on hold', 'exception'],
  ['cancelled', 'exception'],
]);

/** The stage BJS's own wording gives a status, if the map knows it. */
export function bjsMappedStage(wording: string): Stage | undefined {
  return STATUSES.get(normalizeStatusWording(wording));
}

/** A status's stage: the map, else the shared wording rules. */
export function bjsStage(wording: string): ClassifiedWording | null {
  const mapped = bjsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? bjsMappedStage(wording) : undefined),
  gaps: [],
};
