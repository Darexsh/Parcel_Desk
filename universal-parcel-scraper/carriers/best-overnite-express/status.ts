import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scans carry no code, only the carrier's wording in capitals. The
 * wordings of the tracking service and of the classic PRO trace, whose status
 * column used short codes, are mapped; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['PICK UP MADE', 'accepted'],
  ['DELIVERED (CLEAR)', 'delivered'], // A delivery signed for without exceptions.
  ['LINE', 'in_transit'], // Classic trace: on a line-haul trip between terminals.
  ['DELVR', 'delivered'], // Classic trace: delivered from the destination terminal.
  ['DELIVERED', 'delivered'], // Classic trace: the signature line.
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording. */
export function boeMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function boeStage(wording: string): ClassifiedWording | null {
  const mapped = boeMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => boeMappedStage(wording),
  gaps: [],
};
