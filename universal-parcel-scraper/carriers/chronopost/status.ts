import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

type ChronopostStage = ClassifiedWording['stage'];

const RETURN_CODE = 'R';
const RETURN_LABEL = 'Colis en retour expéditeur';

/** Each code with the wordings observed under it. Partner events can reuse codes, so both must agree. */
const OBSERVED: ReadonlyArray<readonly [code: string, label: string, stage: ChronopostStage]> = [
  ['DC', "Colis en cours de préparation chez l'expéditeur", 'registered'],
  // Written with the label, before the parcel is handed over: it is one of several in a shipment.
  ['EA', "Colis faisant partie d'une expédition groupée", 'registered'],
  ['DB', "Colis déposé par l'expéditeur", 'accepted'],
  // The courier takes over a parcel dropped at a pickup point, right after the point hands it over.
  ['PC', 'Colis pris en charge par le transporteur', 'accepted'],
  // The first depot's sort, under either code, as it takes the parcel over.
  ['SC', "Tri effectué dans l'agence de départ", 'in_transit'],
  ['EC', "Tri effectué dans l'agence de départ", 'in_transit'],
  ['TS', "Colis en cours d'acheminement", 'in_transit'],
  ['O', "Colis en cours d'acheminement", 'in_transit'],
  ['TP', "Colis en cours d'acheminement", 'in_transit'],
  ['T', "Entrée dans l'agence", 'in_transit'],
  // The pickup point hands the courier the parcel the sender dropped there; the courier's take-over follows.
  ['TT', 'Colis remis par le relais Pickup au chauffeur', 'accepted'],
  ['EI', 'Colis entré dans le pays de destination', 'in_transit'],
  ['SJ', "Problème douanier résolu, colis en cours d'acheminement", 'in_transit'],
  // The delivery depot's sort, ahead of its round.
  ['SD', "Tri effectué dans l'agence de distribution", 'in_transit'],
  ['A2', "Colis retardé à l'agence de distribution", 'in_transit'],
  // A delay on the way, like the delivery depot's: the parcel moves on by itself.
  ['CR', "Colis retardé durant l'acheminement", 'in_transit'],
  ['AT', "Colis retardé durant l'acheminement", 'in_transit'],
  // A depot repacked the parcel, a minute after its sort, and sent it on.
  ['RO', "Colis reconditionné pendant l'acheminement", 'in_transit'],
  ['IS', 'Livraison prévue lundi prochain', 'in_transit'],
  // The depot holds the parcel a day without trying to deliver it: a missort, an address being
  // checked, or a recipient closed that day. Delivery resumes on its own.
  ['SD', 'Livraison reportée de 24h', 'in_transit'],
  ['IA', 'Livraison reportée de 24h', 'in_transit'],
  // A delivery partner's postponement, which Chronopost relays without a reason or an attempt.
  // Nothing is asked of the recipient, so it is a delay as well.
  ['N', 'Livraison reportée', 'in_transit'],
  // The partner's missed round under the same code, with or without its reason, and the reason
  // restated once the recipient's instruction asks for another address: one attempt, before the
  // postponement that follows it.
  ['N', 'Colis non livré', 'failed_attempt'],
  ['N', 'Colis non livré : client absent', 'failed_attempt'],
  ['N', "Colis non livré : changement d'adresse nécessaire", 'failed_attempt'],
  // The round, the courier on the way to a pickup point and its arrival there. They come
  // within two minutes of the delivering partner's own scans, and La Poste's feed stages the
  // same scans alike as MD1, ET1 and AG1.
  ['TA', 'Colis en cours de livraison', 'out_for_delivery'],
  ['TA', 'Colis en cours de livraison par le livreur', 'out_for_delivery'],
  ['RB', 'Colis en cours de livraison au point de retrait', 'in_transit'],
  ['AB', 'Colis mis à disposition au point de retrait', 'ready_for_pickup'],
  // The courier left the parcel at another pickup point than the one planned, where it waits.
  // Before the parcel has moved, it is the sender's drop-off at another point (see the parser).
  ['AB', 'Colis mis à disposition dans un point de retrait différent de celui prévu', 'ready_for_pickup'],
  // The same arrival at the pickup point, also written under SD and under MD.
  ['SD', 'Colis mis à disposition au point de retrait', 'ready_for_pickup'],
  ['MD', 'Colis mis à disposition au point de retrait', 'ready_for_pickup'],
  ['D', 'Livraison effectuée', 'delivered'],
  // The recipient collects the parcel at the pickup point it waited at.
  ['RI', 'Colis remis au destinataire au point de retrait', 'delivered'],
  ['P', "Echec de livraison suite à l'absence du destinataire.", 'failed_attempt'],
  ['SK', "Colis en attente d'informations complémentaires de votre part", 'exception'],
  // A damaged parcel or one packed too poorly to travel is held until Chronopost deals with it.
  ['S', 'Colis bloqué : colis endommagé ou emballage insuffisant', 'exception'],
  // The parcel starts back to the sender. Like other returns under way it stays nonterminal:
  // the return's own scans follow, and its delivery is the return's (see the parser).
  [RETURN_CODE, RETURN_LABEL, 'exception'],
  // The sender called off the hand-over: Chronopost never had the parcel. A new preparation scan can follow.
  ['AN', "Remise du colis annulée par l'expéditeur", 'exception'],
];

const observed = new Map<string, Map<string, ChronopostStage>>();
for (const [code, label, stage] of OBSERVED) observed.set(code, (observed.get(code) ?? new Map<string, ChronopostStage>()).set(label, stage));

const NOTIFICATION = 'Destinataire informé par SMS ou mail';
const INSTRUCTION = 'Instruction de livraison reçue';
/** Chronopost's notice to the recipient, which providers relay as it is. */
export const CHRONOPOST_NOTIFICATION = NOTIFICATION;

/** A notice to the recipient, or the recipient's own delivery instruction: neither is a scan. */
export function isChronopostNotification(label: string): boolean {
  return label === NOTIFICATION || label === INSTRUCTION;
}

/** The scan that sends the parcel back to its sender. */
export function isReturnToSender(code: string, label: string): boolean {
  return code === RETURN_CODE && label === RETURN_LABEL;
}

/** The courier's drop-off scan, which can follow the pickup point's own arrival scan. */
export function isPickupDropOff(code: string, label: string): boolean {
  return code === 'RB' && label === 'Colis en cours de livraison au point de retrait';
}

/** A pickup point's scan of a parcel at another point than the one planned. */
export function isOtherPickupPoint(code: string, label: string): boolean {
  return code === 'AB' && label === 'Colis mis à disposition dans un point de retrait différent de celui prévu';
}

/** Partner events can reuse codes; the observed wording must agree with the code. */
export function chronopostStage(code: string, label: string): ClassifiedWording {
  const stage = observed.get(code)?.get(label);
  return stage ? { stage, source: 'carrier_map' } : classifyWording(label, 'pending');
}

/** What the map says about one scan: a code whose observed wording it carries. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    for (const [label, stage] of (code ? observed.get(code) : undefined) ?? []) {
      if (normalizeStatusWording(label) === wording) return stage;
    }
    return undefined;
  },
  gaps: [{
    code: 'SM', wording: normalizeStatusWording(NOTIFICATION),
    note: 'A notice to the recipient, not a scan: it keeps the stage the parcel already had.',
  }, {
    code: 'CL', wording: normalizeStatusWording(INSTRUCTION),
    note: "The recipient's delivery instruction, not a scan: it keeps the stage the parcel already had.",
  }],
};
