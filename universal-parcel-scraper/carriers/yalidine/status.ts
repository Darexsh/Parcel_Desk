import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ["Pas encore expédié", "registered"],
  ["A vérifier", "registered"],
  ["En préparation", "registered"],
  ["Pas encore ramassé", "registered"],
  ["Prêt à expédier", "registered"],
  ["En passation", "registered"],
  ["Ramassé", "accepted"],
  ["Bloqué", "exception"],
  ["Débloqué", "in_transit"],
  ["Transfert", "in_transit"],
  ["Expédié", "in_transit"],
  ["Centre", "in_transit"],
  ["En localisation", "in_transit"],
  ["Vers Wilaya", "in_transit"],
  ["En transit", "in_transit"],
  ["Reçu à Wilaya", "in_transit"],
  ["En attente du client", "ready_for_pickup"],
  ["Prêt pour livreur", "in_transit"],
  ["Sorti en livraison", "out_for_delivery"],
  ["En attente", "exception"],
  ["Annulé", "exception"],
  ["En alerte", "exception"],
  ["Alerte résolue", "in_transit"],
  ["Tentative échouée", "failed_attempt"],
  ["Livré", "delivered"],
  ["Echèc livraison", "failed_attempt"],
  ["Retour vers centre", "returned"],
  ["Retourné au centre", "returned"],
  ["Retour transfert", "returned"],
  ["Retour groupé", "returned"],
  ["Retour à retirer", "returned"],
  ["Retour vers vendeur", "returned"],
  ["Retourné au vendeur", "returned"],
  ["Echange échoué", "exception"],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

export function yalidineMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export function yalidineStage(wording: string): ClassifiedWording | null {
  const stage = yalidineMappedStage(wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => yalidineMappedStage(wording),
  gaps: [],
};
