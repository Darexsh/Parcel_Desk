import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings City Express's tracker gives its scans and the status above
 * them, in English and in Serbian, which carry no code. Another wording falls
 * to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // A courier is on the way to collect the parcel from the sender.
  ['pickup in progress', 'registered'],
  ['preuzimanje u toku', 'registered'],
  // Entered at the depot, on the evening of the pickup.
  ['initialization', 'accepted'],
  ['pošiljka uneta u sistem', 'accepted'],
  ['loaded for delivery', 'out_for_delivery'],
  ['utovareno za dostavu', 'out_for_delivery'],
  ['utovareno za isporuku', 'out_for_delivery'],
  ['na isporuci', 'out_for_delivery'],
  // Put in a parcel locker, where the recipient collects it.
  ['deposit in parcel terminal', 'ready_for_pickup'],
  ['isporučeno na paketomat', 'ready_for_pickup'],
  ['delivered', 'delivered'],
  ['isporučeno', 'delivered'],
]);

/** The stage City Express's map gives a wording in `normalizeStatusWording` form. */
export function cityExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's or status's stage: the map, else the shared wording rules, else nothing. */
export function cityExpressStage(wording: string): ClassifiedWording | null {
  const mapped = cityExpressMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => cityExpressMappedStage(wording),
  gaps: [],
};
