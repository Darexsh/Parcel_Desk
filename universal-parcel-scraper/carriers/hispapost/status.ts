import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's status wordings, in the normalized form, that replies showed.
 * The status comes without a code; another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['entregado', 'delivered'],
  // Sent back after it waited at a delivery office and nobody collected it.
  ['devuelto a origen - no retirado en oficina', 'returned'],
]);

/** The stage the map gives a status wording. */
export function hispapostMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A status's stage: its wording in the map, else the shared wording rules, else nothing. */
export function hispapostStage(wording: string): ClassifiedWording | null {
  const mapped = hispapostMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : hispapostMappedStage(wording)),
  gaps: [],
};
