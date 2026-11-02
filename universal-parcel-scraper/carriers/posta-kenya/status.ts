import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event names Posta Kenya's tracker prints, in English and without a code.
 * Scans relayed from the posts abroad use the same names. The shared rules read
 * several of them as no milestone, or as an acceptance, so the map names each
 * one seen in a reply; another name falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['received the shipment from customer', 'accepted'],
  ['dispatched', 'in_transit'],
  ['bagged', 'in_transit'],
  ['received the item', 'in_transit'],
  ['received at location', 'in_transit'],
  // Sic: the tracker misspells this name.
  ['received at exchnage office for dispatch', 'in_transit'],
  // Arrived in a country of transit or of destination.
  ['received at exchange office for delivery', 'in_transit'],
  ['with customs', 'customs'],
  // Customs handed the item back to the post for delivery, a release, which the shared rules read as customs.
  ['shipment returned by customs', 'in_transit'],
  // The reason and the measure taken follow the name.
  ['undelivered', 'failed_attempt'],
  ['delivered', 'delivered'],
]);

/** The stage the map gives an event name, if it knows it. */
export function postaKenyaWordingStage(name: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(name));
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function postaKenyaStage(name: string): ClassifiedWording | null {
  const mapped = postaKenyaWordingStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A scan's wording is its event name, then the reason
 * and the measure taken after a colon; the event name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : postaKenyaWordingStage(wording.split(': ')[0]!)),
  gaps: [],
};
