import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * BlueEX's wordings, read by how they start: the station, the city and a
 * failed attempt's reason vary. The tracker gives no code. The first two
 * starts also cover its former tracker's wording.
 */
const ACTIONS: readonly (readonly [RegExp, Stage])[] = [
  // The shipper booked it and has not handed it over.
  [/^order information received\b/, 'registered'],
  [/^shipment is being processed\b/, 'registered'],
  [/^shipment (?:has )?reached\b/, 'in_transit'],
  [/^shipment is on route to\b/, 'in_transit'],
  [/^out for delivery\b/, 'out_for_delivery'],
  [/^unsuccessful attempt(?:ed)?\b/, 'failed_attempt'],
  [/^(?:shipment has been )?delivered\b/, 'delivered'],
];

/** The stage a BlueEX wording starts with, read case-insensitively. */
export function blueexWordingStage(wording: string): Stage | undefined {
  const text = wording.toLowerCase().trim().split(/\s+/).join(' ');
  return ACTIONS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function blueexStage(wording: string): ClassifiedWording | null {
  const mapped = blueexWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => blueexWordingStage(wording),
  gaps: [],
};
