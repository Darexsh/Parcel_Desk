import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's event codes, each history row's `EventID`, with the stage each
 * gives. Metropolitan registers the order, collects the furniture from the
 * vendor, brings it to its hub, then to the hub that delivers it, and delivers
 * it after its crew arrives at the address.
 */
const EVENTS: Readonly<Record<string, Stage>> = {
  1: 'registered', // Order registered
  10: 'registered', // Pickup scheduled for {date}
  18: 'accepted', // Pickup completed, No exceptions
  24: 'in_transit', // Order enroute to Metro-Hub
  23: 'in_transit', // Furniture Received by Metro-Hub
  107: 'in_transit', // Reached Delivery Hub
  86: 'out_for_delivery', // Arrived at Delivery Location
  54: 'delivered', // Delivery Completed, No Exceptions
};

/** Codes that move nothing: paperwork, and the delivery appointment, a delivery still to come. */
const QUIET: Readonly<Record<string, string>> = {
  92: 'A document was attached for the pickup; paperwork moves nothing.',
  43: 'The delivery was scheduled for a week: a delivery still to come.',
  46: 'The delivery was moved to another week: a delivery still to come.',
  44: 'The delivery appointment was cancelled, and a new one is scheduled after it; it moves nothing.',
};

/** The stage the map gives an event code, if it knows it. */
export function metropolitanWarehouseMappedStage(code: string): Stage | undefined {
  return Object.hasOwn(EVENTS, code) ? EVENTS[code] : undefined;
}

/**
 * A row's stage: its code, else nothing for a code that moves nothing, else
 * the shared wording rules for a code the map does not know, else nothing.
 */
export function metropolitanWarehouseStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = metropolitanWarehouseMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (Object.hasOwn(QUIET, code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? metropolitanWarehouseMappedStage(code) : undefined),
  gaps: Object.entries(QUIET).map(([code, note]) => ({ code, note })),
};
