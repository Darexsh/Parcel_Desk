import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * AnserX's tracking codes: `BTY_`, the leg of the journey and its step. Only
 * codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['BTY_ORDER_CREATED', 'registered'], // The seller's order details reached AnserX.
  ['BTY_WAREHOUSE_INBOUND', 'accepted'], // Received at AnserX's sorting centre in China.
  ['BTY_WAREHOUSE_OUTBOUND', 'in_transit'],
  ['BTY_LINE_HANDOVER', 'in_transit'], // Handed to the airline, then departed from the origin port.
  ['BTY_LINE_ARRIVED', 'in_transit'], // At the destination port.
  // Cleared at destination: the Chinese wording says import clearance, the
  // English one export. Clearance done puts the parcel back in transit.
  ['BTY_EXCC_COMPLETED', 'in_transit'],
  ['BTY_LASTMILE_TRANSIT', 'in_transit'], // With the delivery carrier, before its round.
  ['BTY_LASTMILE_DELIVERING', 'out_for_delivery'],
  ['BTY_LASTMILE_DELIVERED', 'delivered'],
]);

/** The stage AnserX's codes give a scan code. */
export function anserxMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function anserxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = anserxMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen moves the parcel; none is left out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? anserxMappedStage(code) : undefined),
  gaps: [],
};
