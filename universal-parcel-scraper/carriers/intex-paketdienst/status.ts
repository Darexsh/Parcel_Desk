import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The statuses INTEX's tracker shows, in German. The rows carry no code. */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // INTEX has the shipment's data; it has not scanned the parcel yet.
  ['dateneingang intex', 'registered'],
  ['eingang hauptumschlagsplatz', 'in_transit'],
  ['ausgang hauptumschlagsplatz', 'in_transit'],
  // At the station that delivers it; the round has not started.
  ['eingang auslieferstation', 'in_transit'],
]);

/** The stage the map gives INTEX's wording, if it knows it. */
export function intexScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function intexStage(wording: string): ClassifiedWording | null {
  const mapped = intexScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : intexScanStage(wording)),
  gaps: [],
};
