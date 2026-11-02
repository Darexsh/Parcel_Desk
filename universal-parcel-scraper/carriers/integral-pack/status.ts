import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's names for a guide's events and current state, which carry no
 * code, and the steps of its progress rail. Only wording seen in replies or on
 * the tracking page is mapped; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The guide is a sale at the origin agency's point of sale, which takes the
  // parcel in; the rail calls that step `Admitida`.
  ['Creada', 'accepted'],
  ['Admitida', 'accepted'],
  ['En tránsito', 'in_transit'],
  // At the destination branch, before it is handed over or taken out.
  ['En destino', 'in_transit'],
  ['En reparto', 'out_for_delivery'],
  // Also the state of a parcel the recipient collected at the branch.
  ['Entregada', 'delivered'],
  ['Entregado', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives an event's or state's name. */
export function integralPackMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A name's stage: the map, else the shared wording rules, else nothing. */
export function integralPackStage(wording: string): ClassifiedWording | null {
  const mapped = integralPackMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => integralPackMappedStage(wording),
  gaps: [],
};
