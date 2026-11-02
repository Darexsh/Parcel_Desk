import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The steps Jet Logistic's cargo check names, without the warehouse's town.
 * Cargo travels between Jet Logistic's warehouses: the sender brings it to the
 * receiving warehouse or has it collected, and the recipient collects it from
 * the issuing warehouse or has it brought.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['забор груза от грузоотправителя', 'accepted'], // Collected from the sender.
  ['доставка груза на склад приемки', 'accepted'], // At the receiving warehouse, brought or collected.
  ['отправка груза со склада приемки', 'in_transit'],
  // At the issuing warehouse. A door delivery can still follow, so it is not a wait for collection.
  ['доставка груза на склад выдачи', 'in_transit'],
  ['груз выдан', 'delivered'],
]);

/** The stage Jet Logistic's own wording gives, in `normalizeStatusWording` form. */
export function jetLogisticMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A step's stage: its wording, else the shared wording rules, else nothing. */
export function jetLogisticStage(wording: string): ClassifiedWording | null {
  const mapped = jetLogisticMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jetLogisticMappedStage(wording),
  gaps: [],
};
