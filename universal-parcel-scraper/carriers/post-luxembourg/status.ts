import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * POST Luxembourg names each event with its UPU event code and words it in
 * the requested language. Its own events and those a destination post relays
 * share the code. The map holds the codes seen in replies; "Entry into the
 * postal network", the posting, reads as nothing to the shared rules.
 */
const EVENTS: Readonly<Record<string, Stage>> = {
  EMA: 'accepted',
  EMC: 'in_transit',
  EMD: 'in_transit',
  EMF: 'in_transit',
  EMG: 'in_transit',
  EDD: 'in_transit',
  EDG: 'out_for_delivery',
  EMI: 'delivered',
};

/** The stage POST Luxembourg's event code gives a scan, if the map knows it. */
export function postLuxembourgCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(EVENTS, code) ? EVENTS[code] : undefined;
}

/**
 * A scan's stage from its code, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function postLuxembourgStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = postLuxembourgCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries a code; the map reads the code alone. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? postLuxembourgCodeStage(code) : undefined),
  gaps: [],
};
