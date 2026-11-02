import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import evidence from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(evidence.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const CODES = new Map(evidence.entries.filter(entry => entry.code).map(entry => [entry.code!, entry.stage as Stage]));

export function ecmsExpressStage(code: string, wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording)) ?? CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => WORDINGS.get(wording) ?? CODES.get(code ?? ''), gaps: [] };
