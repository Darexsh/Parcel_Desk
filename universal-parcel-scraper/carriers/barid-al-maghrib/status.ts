import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of the tracking page's history, which carries no codes. Only
 * wordings seen on the page are mapped; another falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Taken in at the counter, by Barid Al-Maghrib or the post that sent the item.
  ['ENVOI PRIS EN CHARGE', 'accepted'],
  // At the sending post's office of exchange.
  ['ENVOI REÇU POUR EXPORT', 'in_transit'],
  // Sent on: from the sending post, the exchange office or a sorting centre.
  ['ENVOI ÉXPÉDIÉ', 'in_transit'],
  // Mail from abroad at the exchange office in Morocco.
  ['ENVOI REÇU AU MAROC', 'in_transit'],
  ['ENVOI SOUS DOUANE', 'customs'],
  // Released by customs, which sends the item on.
  ['ENVOI DÉDOUANÉ', 'in_transit'],
  // At the delivery office, before it goes out.
  ['ENVOI ARRIVÉ À DESTINATION', 'in_transit'],
  ['ENVOI EN COURS DE LIVRAISON', 'out_for_delivery'],
  ['ENVOI LIVRÉ', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function baridAlMaghribMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function baridAlMaghribStage(wording: string): ClassifiedWording | null {
  const mapped = baridAlMaghribMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => baridAlMaghribMappedStage(wording),
  gaps: [],
};
