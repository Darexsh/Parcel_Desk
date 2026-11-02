import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses Morning Global's tracker gives its scans, which carry no code.
 * A scan whose description adds to its status reads "Status: description",
 * and is staged by its status. Another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['order created', 'registered'],
  ['collection', 'accepted'],
  ['arrive hub', 'in_transit'],
  ['depart origin', 'in_transit'],
  ['depart hub', 'in_transit'], // On the former tracker page.
  ['ready for departure', 'in_transit'],
  ['flight departure to destination', 'in_transit'],
  ['arrive destination', 'in_transit'],
  ['customs clearance begins', 'customs'],
  ['customs cleared', 'in_transit'],
  ['handed over for delivery', 'in_transit'], // Handed to the delivery partner in the destination country.
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage Morning Global's map gives a wording in `normalizeStatusWording` form, read by its status. */
export function morningGlobalMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? WORDINGS.get(wording.split(': ')[0]!);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function morningGlobalStage(wording: string): ClassifiedWording | null {
  const mapped = morningGlobalMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => morningGlobalMappedStage(wording),
  gaps: [],
};
