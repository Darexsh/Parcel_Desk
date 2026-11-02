import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of the EMS Champion Post Algérie tracker, which carries no
 * codes. The sending post's scans of mail from abroad come in the same
 * French wordings. Only wordings seen on the tracker are mapped; another
 * falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Envoi déposé', 'accepted'],
  // At the sending post's office of exchange.
  ['Arrivée au centre d\'exportation', 'in_transit'],
  ['Départ vers le pays de destination', 'in_transit'],
  // At the office of exchange in the destination country.
  ['Arrivée au pays de destination', 'in_transit'],
  ['Présentation au service des Douanes', 'customs'],
  ['Attente de controle douane', 'customs'],
  // Released by customs, which sends the item on.
  ['Dédouanement effectué', 'in_transit'],
  ['Recevoir envoi au centre de tri (Ent)', 'in_transit'],
  ['Expédier envoi hors du centre de tri (Ent)', 'in_transit'],
  ['Expédier envoi à adresse nationale (Ent)', 'in_transit'],
  ['Arrivée au bureau de distribution', 'in_transit'],
  ['En cours d\'acheminement', 'in_transit'],
  // Taken in at an EMS counter or agency on the way.
  ['Entrée en transit', 'in_transit'],
  ['En cours de Distribution', 'out_for_delivery'],
  ['Echec de Distribution', 'failed_attempt'],
  ['Distribué', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function algeriePosteMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function algeriePosteStage(wording: string): ClassifiedWording | null {
  if (!wording) return null;
  const mapped = algeriePosteMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => algeriePosteMappedStage(wording),
  gaps: [],
};
