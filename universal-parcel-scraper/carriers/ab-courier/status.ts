import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order statuses of A&B's dispatch system, as its tracking page groups
 * them for the picture over the page. None carries a code. A status after a
 * pickup repeats "Picked Up" before the step, with two spaces, which the map
 * reads as one.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The order is booked, given to a driver and on the driver's list: the pickup is still to come.
  ['open', 'registered'],
  ['assigned', 'registered'],
  ['dispatched', 'registered'],
  ['picked up', 'accepted'],
  ['picked up in transit on time', 'in_transit'],
  // At the dock that delivers it.
  ['picked up destination dock', 'in_transit'],
  ['picked up out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  // The order closed after its delivery; the page shows it as delivered.
  ['finalized', 'delivered'],
  ['cancelled', 'exception'],
]);

/**
 * The picture's steps, which the reply names with each status: scheduled for
 * pickup, picked up, en route, almost there and delivered. Almost there does
 * not say whether the driver has left with the parcel.
 */
const RAIL: ReadonlyMap<string, Stage> = new Map([
  ['TrackingStage1', 'registered'],
  ['TrackingStage2', 'accepted'],
  ['TrackingStage3', 'in_transit'],
  ['TrackingStage4', 'in_transit'],
  ['TrackingStage5', 'delivered'],
]);

/** The stage the map gives A&B's status, if it knows it. */
export function abCourierMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A status's stage: the map, else the picture's step the reply names with it,
 * else the shared wording rules. A status none of them knows has no stage.
 */
export function abCourierStage(wording: string, step = ''): ClassifiedWording | null {
  const mapped = abCourierMappedStage(wording) ?? RAIL.get(step);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!wording) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The statuses carry wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : abCourierMappedStage(wording)),
  gaps: [],
};
