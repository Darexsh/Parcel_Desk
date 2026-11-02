import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of TST-CF Express's tracing results: the shipment's status line
 * and the labels of the dated fields the parser turns into milestones. None of
 * them carries a code.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  // The pickup, with the PRO it was given, before the freight bill is entered.
  [/^pickup completed(?:, pro \d{3}-?\d{7} assigned)?$/, 'accepted'],
  // The page's "Shipped" day, the pickup's.
  [/^shipped$/, 'accepted'],
  // A terminal's dock, named with its province or state: "Currently on SAMPLETON ON dock".
  [/^currently on .+ dock$/, 'in_transit'],
  // The lane between two terminals: "In transit between SAMPLETON, ON and Example City, OH".
  [/^in transit between .+ and .+$/, 'in_transit'],
  // The page's "Customs Release" clock: customs let the freight go on.
  [/^customs release$/, 'in_transit'],
  // "Delivered on 01/15/2025 at 14:05", or the delivery the parser keeps without its clock.
  [/^delivered(?: on \d{1,2}\/\d{1,2}\/\d{4}(?: at \d{1,2}:\d{2})?)?$/, 'delivered'],
];

/** The stage the map gives TST-CF's wording, if it knows it. */
export function tstCfMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * A status's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function tstCfStage(wording: string): ClassifiedWording | null {
  const mapped = tstCfMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tstCfMappedStage(wording)),
  gaps: [],
};
