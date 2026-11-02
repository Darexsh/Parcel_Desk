import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * NOEST's event wording, in `normalizeStatusWording` form, as its tracker and
 * its merchant API documentation give it. The tracker shows no codes. Other
 * wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The merchant created the order, then validated it, which makes it visible to NOEST.
  ['uploadé sur le système', 'registered'],
  ['validé', 'registered'],
  ['colis ramassé', 'accepted'],
  // Received at a NOEST hub, then taken from it by a driver.
  ['reception validé', 'in_transit'],
  ['enlevé par le livreur', 'in_transit'],
  // The driver's delivery run started.
  ['en livraison', 'out_for_delivery'],
  ['tentative de livraison', 'failed_attempt'],
  ['livré', 'delivered'],
  // A return the merchant or a hub asked for, on its way back and handed to the merchant.
  ['retour demandé par le partenaire', 'returned'],
  ['retour en transit', 'returned'],
  ['retour transmis au partenaire', 'returned'],
  ['retour transmis vers entrepôt', 'returned'],
  ['retour reçu par le partenaire', 'returned'],
  ['retour validé par le partenaire', 'returned'],
  // A return sent out for delivery again.
  ['retour remis en livraison', 'in_transit'],
  ['suspendu', 'exception'],
  // The merchant deleted the order; nothing is shipped.
  ['commande supprimée', 'exception'],
]);

const GAPS = [
  { wording: 'montant transmis au partenaire', note: 'The cash collected on delivery paid out to the merchant; it moves nothing.' },
  { wording: 'montant reçu par le partenaire', note: 'The merchant confirming the cash it was paid; it moves nothing.' },
  { wording: 'versement annulé', note: 'A payout to the merchant cancelled; it moves nothing.' },
  { wording: 'informations modifiées', note: 'The order details edited; it moves nothing.' },
  { wording: 'prix modifié', note: 'The amount to collect edited; it moves nothing.' },
  { wording: 'changement de wilaya', note: 'The destination province changed on the order; the next scans carry the stage.' },
  { wording: 'surfacturation du colis', note: 'An extra fee charged for the parcel; it moves nothing.' },
  { wording: 'demande de suppression', note: 'A request to delete the order; the deletion, if it comes, is its own event.' },
  { wording: 'nouvelle tentative demandée par le vendeur', note: 'The merchant asking for another delivery attempt; the next scans carry the stage.' },
] as const;
const NOTES: ReadonlySet<string> = new Set(GAPS.map(({ wording }) => wording));

/** The stage NOEST's own wording gives an event. */
export function noestMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An event's stage: NOEST's wording, else the shared rules, else nothing. */
export function noestStage(wording: string): ClassifiedWording | null {
  const mapped = noestMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTES.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : noestMappedStage(wording)),
  gaps: GAPS,
};
