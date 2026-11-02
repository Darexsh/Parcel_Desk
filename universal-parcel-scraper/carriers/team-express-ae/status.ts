import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Status details that stage a scan whatever status the tracker files them
 * under. Its "In Transit" also files an export's first scan at Team Express's
 * own center, and "OTHERS" collects whatever its other statuses do not.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment collected at despatch center', 'accepted'],
  ['shipment collected from shipper', 'accepted'],
  ['forwarded to destination', 'in_transit'], // Handed on toward the destination country.
]);

/** The tracker's statuses, which also head the summary as its current status. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  ['collected', 'accepted'],
  ['in transit', 'in_transit'],
  ['shipment arrived at hub facility', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage a status gives on its own: the summary's current status has no details. */
export function teamExpressCodeStage(code: string): Stage | undefined {
  return CODES.get(normalizeStatusWording(code));
}

/** The stage the map gives a scan: its details, else its status. */
export function teamExpressMappedStage(code: string, wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? teamExpressCodeStage(code);
}

/** A scan's stage: the map, else the shared wording rules on its details or status, else nothing. */
export function teamExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = teamExpressMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording || code, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => teamExpressMappedStage(code ?? '', wording),
  gaps: [],
};
