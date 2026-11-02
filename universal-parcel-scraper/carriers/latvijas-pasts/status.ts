import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Latvijas Pasts names each scan with a numeric event code and words it in the
 * requested language. Its own offices and the foreign posts' events it relays
 * share one code list. Several codes read as the wrong milestone to the shared
 * classifier: "Item returned from Customs" is a release, not a return.
 */
const EVENTS: Readonly<Record<string, Stage>> = {
  // Electronic data: the item is announced, not yet handed over.
  1112: 'registered',
  1114: 'registered',
  1: 'accepted',
  78: 'accepted',
  2: 'in_transit',
  3: 'in_transit',
  // Presented to customs at the office of exchange; code 7 is its release.
  4: 'customs',
  7: 'in_transit',
  8: 'in_transit',
  12: 'in_transit',
  30: 'in_transit',
  32: 'in_transit',
  35: 'in_transit',
  69: 'in_transit',
  77: 'in_transit',
  1113: 'in_transit',
  1120: 'in_transit',
  39: 'out_for_delivery',
  // The delivery office printed the invitation to collect the item there.
  1134: 'ready_for_pickup',
  37: 'delivered',
};

/** The stage Latvijas Pasts' event code gives a scan, if the map knows it. */
export function latvijasPastsCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(EVENTS, code) ? EVENTS[code] : undefined;
}

/**
 * A scan's stage from its code, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function latvijasPastsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = latvijasPastsCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries a code; the map reads the code alone. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? latvijasPastsCodeStage(code) : undefined),
  gaps: [],
};
