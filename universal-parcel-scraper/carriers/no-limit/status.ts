import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses of NO LIMIT's tracker, which carry no code: the English page's
 * wording, which the adapter reads, and the Polish page's for the same status.
 * Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The order is in NO LIMIT's system; nothing has moved yet.
  ['Order accepted', 'registered'],
  ['Przyjęcie zlecenia', 'registered'],
  // At a branch's warehouse: the first after collection, and again at the delivering branch.
  ['Warehouse', 'in_transit'],
  ['Magazyn', 'in_transit'],
  // On the road between branches.
  ['In realization', 'in_transit'],
  ['W drodze', 'in_transit'],
  ['Issued to courier', 'out_for_delivery'],
  ['Wydano kurierowi', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Doręczona', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage NO LIMIT's map gives a wording in `normalizeStatusWording` form. */
export function noLimitMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function noLimitStage(wording: string): ClassifiedWording | null {
  const mapped = noLimitMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => noLimitMappedStage(wording),
  gaps: [],
};
