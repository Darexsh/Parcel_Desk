import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status wordings TDN's tracker showed, in the normalized form. The
 * status comes without a code; another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The rail's first slot: TDN has the expedition.
  ['recibido', 'accepted'],
  ['entregado', 'delivered'],
]);

/** The stage the map gives a status wording. */
export function tdnMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A status's stage: its wording in the map, else the shared wording rules, else nothing. */
export function tdnStage(wording: string): ClassifiedWording | null {
  const mapped = tdnMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker's status carries wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tdnMappedStage(wording)),
  gaps: [],
};
