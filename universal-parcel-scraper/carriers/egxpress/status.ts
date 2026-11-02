import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Domestic tracking codes seen in EGXPRESS's guest history. */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['DF', 'in_transit'],
  ['AH', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['POD', 'delivered'],
]);

export function egxpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = STAGES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code.toUpperCase()) : undefined),
  gaps: [],
};
