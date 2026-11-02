import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's steps: each code with the label the French tracking page
 * shows for it and the stage it gives. The page holds a label for each of
 * these; another code falls to the shared wording rules.
 */
const STEPS: ReadonlyMap<string, { label: string; stage: Stage }> = new Map([
  ['ordered', { label: 'Etiquette créée', stage: 'registered' }],
  ['collected', { label: 'Colis pris en charge', stage: 'accepted' }],
  ['in-imx-hub', { label: 'Arrivée plateforme Happy-Post', stage: 'in_transit' }], // At the hub that applies the final carrier's label.
  ['leaving-imx-hub', { label: 'Départ plateforme Happy-Post', stage: 'in_transit' }],
  ['international-departure', { label: 'Départ international', stage: 'in_transit' }],
  ['international-transit', { label: 'En transit international', stage: 'in_transit' }],
  ['international-arrival', { label: 'Arrivée pays de destination', stage: 'in_transit' }],
  ['in-delivery', { label: 'En cours de livraison', stage: 'out_for_delivery' }],
  ['notified', { label: 'Avisage', stage: 'failed_attempt' }], // A delivery notice was left.
  ['available-for-delivery-pickup', { label: 'Colis disponible en relais', stage: 'ready_for_pickup' }],
  ['delivered', { label: 'Colis livré', stage: 'delivered' }],
  // Back at Happy-Post's warehouse, where the sender chooses to reship it, redirect it or take it back.
  ['returned_to_warehouse', { label: 'Retour entrepôt Happy-Post', stage: 'exception' }],
  ['reship_to_same_address', { label: 'Choix client : renvoyer à la même adresse.', stage: 'exception' }],
  ['reship_to_other_address', { label: 'Choix client : renvoyer à une autre adresse.', stage: 'exception' }],
  ['return_to_sender', { label: 'Choix client : retour à l’expéditeur.', stage: 'returned' }],
  // Sent out again after a return to the warehouse, though the English page says returned.
  ['reshipped', { label: 'Colis renvoyé', stage: 'in_transit' }],
  ['destroy', { label: 'Colis détruit', stage: 'exception' }],
  ['cancel_destruction', { label: 'Destruction annulée', stage: 'exception' }],
]);

/** The page's label for a step; a code it has no label for shows as the code itself, as on the page. */
export function happyPostLabel(code: string): string {
  return STEPS.get(code)?.label ?? code;
}

/** The stage Happy-Post's step code gives a scan. */
export function happyPostMappedStage(code: string): Stage | undefined {
  return STEPS.get(code)?.stage;
}

/** A step's stage: its code, else the shared wording rules, else nothing. */
export function happyPostStage(code: string): ClassifiedWording | null {
  const mapped = happyPostMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(code.replace(/[-_]+/g, ' '), 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every step carries its code: the map reads it, whatever the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? happyPostMappedStage(code) : undefined),
  gaps: [],
};
