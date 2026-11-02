import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses of TOPTRANS's tracking service, in the Czech it always answers
 * in. The rows carry no code.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The transport order is in; TOPTRANS has not collected the shipment yet.
  ['přijata objednávka přepravy', 'registered'],
  // Collected and brought into the collecting depot's warehouse.
  ['zásilka svezena do skladu', 'accepted'],
  ['zásilka odešla do cílového střediska', 'in_transit'],
  ['zásilka je na rozvozovém středisku', 'in_transit'],
  ['zásilka se rozváží', 'out_for_delivery'],
  ['zásilka doručena', 'delivered'],
]);

/** The stage the map gives TOPTRANS's wording, if it knows it. */
export function toptransScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function toptransStage(wording: string): ClassifiedWording | null {
  const mapped = toptransScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : toptransScanStage(wording)),
  gaps: [],
};
