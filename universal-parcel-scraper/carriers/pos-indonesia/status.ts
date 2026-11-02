import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The state Pos Indonesia's service gives each scan, in upper case as the
 * adapter keeps it. The wording says the same things at more length and
 * names staff, so the states decide. Only states seen in replies are mapped;
 * another falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The waybill made at the counter that takes the item.
  ['PENDING', 'accepted'],
  ['INBAG', 'in_transit'],
  // Received at an office or a processing centre.
  ['INLOCATION', 'in_transit'],
  // Loaded on a vehicle under a dispatch manifest.
  ['INVEHICLE', 'in_transit'],
  ['UNBAG', 'in_transit'],
  // On a postman's delivery run sheet.
  ['DELIVERYRUNSHEET', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
]);

/** The stage a state gives a scan. */
export function posIndonesiaCodeStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage from its state, else the shared wording rules, else nothing. */
export function posIndonesiaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = posIndonesiaCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * Every scan carries a state; the map reads the state alone. The tracking
 * page's own wordings, which other trackers repeat, come from a feed the
 * adapter does not read; they stay with the shared wording rules.
 */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? posIndonesiaCodeStage(code) : undefined),
  gaps: [],
};
