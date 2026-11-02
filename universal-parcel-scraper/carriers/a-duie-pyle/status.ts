import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of A. Duie Pyle's status history: its tracker sends no codes.
 * The freight is in transit from its first departure until the delivery run
 * starts with "Out For Delivery".
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'picked up': 'accepted',
  'departed terminal': 'in_transit',
  'arrived at terminal': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
};

// The billing that follows a delivery, which the reply gives as the shipment's status.
const INVOICED = 'invoiced';

/** The stage the map gives a history row or a status, if it knows the wording. */
export function pyleWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(WORDINGS, normalized) ? WORDINGS[normalized] : undefined;
}

/** A row's stage: Pyle's wording, else the shared wording rules, else nothing. */
export function pyleStage(wording: string): ClassifiedWording | null {
  const mapped = pyleWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording) === INVOICED) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : pyleWordingStage(wording)),
  gaps: [
    { wording: INVOICED, note: 'The shipment was billed after its delivery; it moves nothing.' },
  ],
};
