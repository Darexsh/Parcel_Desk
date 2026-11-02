import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { traceCodeStage } from '../ewe/status.js';

/**
 * A scan's stage: the `action` code of EWE's delivery system, which every scan
 * of the tracker's reply carries, else the shared wording rules, else nothing.
 */
export function homexpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = traceCodeStage(code || null);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => traceCodeStage(code),
  gaps: [],
};
