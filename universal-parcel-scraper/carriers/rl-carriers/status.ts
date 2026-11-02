import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * R+L's history rows, in its words with the terminals' towns. A pickup is
 * the freight leaving the shipper, and a delay keeps the freight in transit:
 * the page's summary calls such a shipment Delayed and shows its estimate.
 */
const SCANS: readonly (readonly [RegExp, Stage])[] = [
  [/^picked up(?: in .+)?$/, 'accepted'],
  [/^arrived at .+$/, 'in_transit'],
  [/^departed .+ in route to .+$/, 'in_transit'],
  [/^shipment delayed$/, 'in_transit'],
  [/^delivered$/, 'delivered'],
];

/** The summary's status above the history. */
const SUMMARY: ReadonlyMap<string, Stage> = new Map([
  ['in transit', 'in_transit'],
  ['delayed', 'in_transit'],
  ['delivered', 'delivered'],
]);

/** The stage the map gives a history row's wording, if it knows it. */
export function rlScanStage(description: string): Stage | undefined {
  const wording = normalizeStatusWording(description);
  return SCANS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** The stage of the summary's status, if the map knows it. */
export function rlSummaryStage(status: string): Stage | undefined {
  return SUMMARY.get(normalizeStatusWording(status));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function rlStage(description: string): ClassifiedWording | null {
  const mapped = rlScanStage(description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : rlScanStage(wording)),
  gaps: [],
};
