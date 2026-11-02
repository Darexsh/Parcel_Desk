import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES: ReadonlyMap<string, Stage> = new Map([
  ['S010', 'pending'], ['S1001', 'in_transit'], ['S354', 'in_transit'], ['S900', 'in_transit'],
  ['S452', 'failed_attempt'], ['S420', 'out_for_delivery'], ['S400', 'delivered'],
  ['8', 'in_transit'], ['12', 'in_transit'], ['30', 'in_transit'], ['35', 'in_transit'],
  ['39', 'out_for_delivery'], ['32', 'in_transit'], ['37', 'delivered'],
]);

export function asyadStage(code: string, wording: string): ClassifiedWording | null {
  const stage = CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: code => CODES.get(code ?? ''), gaps: [] };
