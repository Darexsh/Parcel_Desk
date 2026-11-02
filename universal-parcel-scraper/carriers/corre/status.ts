import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings CORRE's national lookup heads its records with, which carry no
 * code. Only wordings seen in its replies are mapped; another falls to the
 * wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The item's waybill taken in at a CORRE counter, with the item.
  ['GUIA RECEBIDA', 'accepted'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a record's wording, if it knows it. */
export function correMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A record's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function correStage(wording: string): ClassifiedWording | null {
  const mapped = correMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => correMappedStage(wording),
  gaps: [],
};
