import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A wording without case or spaces: the service writes "vre}a (Izlez)" and
 * "vre}a(Izlez)" for the same note.
 */
export function wordingKey(wording: string): string {
  return normalizeStatusWording(wording).replace(/\s+/g, '');
}

/**
 * The service's notes, which carry no codes. They come in Latin letters with
 * some replaced by symbols (`~` for č, `}` for ќ, `{` for š), and are kept so.
 * Only notes seen from the service, or from clients of it, are mapped; another
 * falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Taken in from the sender, at the sending post.
  ['Pratkata se prima od Ispra}a~', 'accepted'],
  // At, then bagged at, an outward office of exchange.
  ['Pristignata vo Naizmeni!na po{ta (Izlez)', 'in_transit'],
  ['Pratkata e stavena vo vre}a (Izlez)', 'in_transit'],
  // At an inward office of exchange, in the country of destination.
  ['Pristignata vo Naizmeni!na po{ta (Vlez)', 'in_transit'],
  // At a post office or sorting centre, which sends it on; repeats for each handover.
  ['Vo Posta', 'in_transit'],
  // Given to the postman to deliver.
  ['Za Dost./ Ispor.', 'out_for_delivery'],
  // Kept at the counter for the recipient to collect.
  ['Za isporaka na {alter', 'ready_for_pickup'],
  ['Ispora~ana', 'delivered'],
  // The tracking page's own rendering of Ispora~ana.
  ['Испорачана', 'delivered'],
  // Not collected by the recipient.
  ['Ne pobaral', 'exception'],
] as const).map(([wording, stage]) => [wordingKey(wording), stage]));

/** The stage the map gives a note, if it knows it. */
export function postaNorthMacedoniaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wordingKey(wording));
}

/** A note's stage from the map, else the shared wording rules, else nothing, which keeps it visible for review. */
export function postaNorthMacedoniaStage(wording: string): ClassifiedWording | null {
  const mapped = postaNorthMacedoniaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The service gives notes only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => postaNorthMacedoniaMappedStage(wording),
  gaps: [],
};
