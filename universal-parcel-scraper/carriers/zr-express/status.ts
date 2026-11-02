import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The states of ZR Express's default workflow, by the code the tracker keys
 * each step with. Only codes seen on the tracker or in ZR's workflow are
 * mapped; another code falls to the wording rules.
 */
const STATES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['commande_recue', 'registered'], // The merchant created the order.
  ['en_traitement', 'registered'],
  ['appel_confirmation', 'registered'], // The buyer is called to confirm the order.
  ['commande_confirmee', 'registered'],
  ['en_preparation', 'registered'],
  ['pret_a_expedier', 'registered'],
  ['dispatch', 'in_transit'], // Sent on within the same wilaya.
  ['vers_wilaya', 'in_transit'], // Sent to another wilaya.
  ['en_livraison', 'in_transit'], // In the delivery stage at the destination; the courier's run is sortie_en_livraison.
  ['sortie_en_livraison', 'out_for_delivery'],
  ['livre', 'delivered'],
  ['encaisse', 'delivered'], // The cash on delivery was collected.
  ['recouvert', 'delivered'], // The cash on delivery was paid out to the merchant.
  ['attente_recuperation_fournisseur', 'returned'], // The returned parcel waits for the merchant.
  ['reinjecte_dans_stock', 'returned'], // The returned parcel went back into the merchant's stock.
  ['recupere_par_fournisseur', 'returned'], // The merchant took the returned parcel back.
]);

/** A parcel checked in at a ZR office: its first acceptance, or a later arrival. */
export const CHECK_IN = 'confirme_au_bureau';

/** The stage a state code gives on its own. */
export function zrExpressMappedStage(code: string): Stage | undefined {
  return STATES.get(code.toLowerCase());
}

/**
 * A step's stage. A check-in at an office accepts the parcel when nothing
 * moved it before; the same state recurs at the destination office and after
 * a delivery run that did not deliver, where it is still in transit.
 */
export function zrExpressStage(code: string, wording: string, moved: boolean): ClassifiedWording | null {
  if (code === CHECK_IN) return { stage: moved ? 'in_transit' : 'accepted', source: 'carrier_map' };
  const mapped = zrExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// A check-in at an office depends on the steps before it, so its code alone gives no stage.
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? zrExpressMappedStage(code) : undefined),
  gaps: [],
};
