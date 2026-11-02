import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Roadrunner's tracking portal: each row of the travel history
 * and the shipment status over it. Neither carries a code. Rows about a
 * trailer or a delivery run name a terminal inside the sentence, so they are
 * matched by their shape. Older shipments' rows name each terminal's town and
 * state instead of its name, as the portal's results page still does.
 */
const RULES: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^pickup request received\.?$/, 'registered'],
  [/^shipment was picked up\.?$/, 'accepted'],
  [/^trailer closed - ready for dispatch\.?$/, 'in_transit'],
  [/^trailer dispatched from .+ to .+$/, 'in_transit'],
  [/^trailer arrived at .+$/, 'in_transit'],
  [/^trailer unloaded at .+$/, 'in_transit'],
  // The delivering terminal arranging a delivery appointment; the freight has not left it.
  [/^appointment pending\.?$/, 'in_transit'],
  [/^attempting to set delivery appointment\.?$/, 'in_transit'],
  [/^left voicemail message to schedule a delivery appointment\.?$/, 'in_transit'],
  [/^shipment out for delivery(?: from .+)?$/, 'out_for_delivery'],
  [/^shipment delivered to consignee\.?$/, 'delivered'],
  // A row, and the status over the page.
  [/^delivered\.?$/, 'delivered'],
  // The status over the page.
  [/^picked up$/, 'accepted'],
  [/^out for delivery$/, 'out_for_delivery'],
];

/** The stage the map gives Roadrunner's wording, if it knows it. */
export function roadrunnerMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return RULES.find(([rule]) => rule.test(normalized))?.[1];
}

/**
 * A row's or the page status's stage from the map, else from the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function roadrunnerStage(wording: string): ClassifiedWording | null {
  const mapped = roadrunnerMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The portal carries wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : roadrunnerMappedStage(wording)),
  gaps: [
    { wording: 'phone number not available', note: 'The delivering terminal could not reach the consignee to book a delivery; it moves nothing.' },
  ],
};
