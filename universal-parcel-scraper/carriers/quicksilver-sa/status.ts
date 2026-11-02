import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Quicksilver's status names, which its tracker shows over each step and the
 * adapter keeps as the provider code. Only names seen on the tracker are
 * mapped; another falls to the shared wording rules.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['place an order', 'registered'], // The shipper created the order.
  ['allocating pickers', 'registered'], // A driver was given the pickup; the parcel is not collected yet.
  ['pending creation', 'registered'], // Seen after the pickup task, before the parcel was received.
  ['received', 'accepted'], // Received at a Quicksilver station.
  ['ready for dispatch', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

// Listed with the earliest clock, before the order was placed, so what it
// marks is unclear; it moves nothing.
const UNCLEAR = new Set(['picked']);

/** The stage Quicksilver's map gives a status name. */
export function quicksilverMappedStage(status: string): Stage | undefined {
  return STATUSES.get(normalizeStatusWording(status));
}

/** A status's stage: the map, else the shared wording rules, else nothing. */
export function quicksilverStage(status: string): ClassifiedWording | null {
  const mapped = quicksilverMappedStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNCLEAR.has(normalizeStatusWording(status))) return null;
  const worded = classifyWording(status, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: (code) => normalizeStatusWording(code),
  stage: (code) => (code ? quicksilverMappedStage(code) : undefined),
  gaps: [
    { code: 'picked', note: 'Listed with the earliest clock, before the order was placed, so what it marks is unclear; it moves nothing.' },
  ],
};
