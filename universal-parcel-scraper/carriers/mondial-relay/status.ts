/**
 * Mondial Relay status vocabulary.
 *
 * The tracking endpoint carries no status code: every state is French prose,
 * in `SuiviContextuel` (the headline), in each event's `Libelle`, and in the
 * `SuiviParEtapes` milestone labels. Matching is therefore done on
 * accent-folded, punctuation-free phrases so that "Retour à l'expéditeur",
 * "retour a l expediteur" and "RETOUR A L'EXPEDITEUR" are one entry.
 *
 * Phrases are grouped most specific first: a return and a failed delivery both
 * mention "livraison", and a pickup that has happened must outrank the parcel
 * merely being available. Wording that matches nothing yields `unknown` with an
 * `in_transit` stage placeholder, which the adapter only uses as an event stage
 * when a more specific source has already set the shipment status.
 */
import { classifyWording, type ClassifiedStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Fold a French label to the form the phrase lists are written in. */
export function comparableText(value: string): string {
  return value
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ordered rules; the first phrase that appears in the folded label wins. */
export const MONDIAL_RELAY_WORDING: readonly { phrases: readonly string[]; classified: ClassifiedStatus }[] = [
  {
    phrases: ['retour a l expediteur', 'retourne a l expediteur', 'retour expediteur', 'retour en cours'],
    classified: { status: 'exception', stage: 'returned' },
  },
  {
    // Carrier-reported problems that are neither a missed attempt nor a return.
    phrases: [
      'anomalie', 'incident', 'adresse incorrecte', 'colis endommage',
      'colis refuse', 'colis perdu',
    ],
    classified: { status: 'exception', stage: 'exception' },
  },
  {
    phrases: ['echec de livraison', 'livraison impossible', 'n a pas pu etre livre'],
    classified: { status: 'exception', stage: 'failed_attempt' },
  },
  {
    phrases: [
      'retire par le destinataire', 'retrait effectue', 'remis au destinataire',
      'livraison effectuee au destinataire', 'colis livre au destinataire',
      // A return the merchant received: "Votre colis a été livré à l'enseigne."
      'livre a l enseigne',
    ],
    classified: { status: 'delivered', stage: 'delivered' },
  },
  {
    phrases: [
      'disponible dans votre point relais', 'disponible au point relais',
      'disponible dans votre locker', 'disponible au locker',
      'disponible au point de retrait', 'disponible en consigne',
      'vous attend au point relais', 'vous attend dans le locker', 'pret a etre retire',
      // The locker countdown: "5 jours restants pour retirer le colis en Locker".
      'restants pour retirer', 'restant pour retirer',
    ],
    classified: { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  },
  {
    phrases: [
      'en cours de livraison', 'livraison en cours', 'en cours de distribution',
      'en cours de mise a disposition',
    ],
    classified: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  },
  {
    phrases: [
      'information transmise par l expediteur', 'en cours de preparation par l expediteur',
      'en preparation chez l expediteur', 'etiquette creee', 'colis enregistre',
    ],
    classified: { status: 'pending', stage: 'registered' },
  },
  {
    // Each logistics site the parcel passes logs its own "prise en charge":
    // movement between hubs, after the hand-in at a relay or locker.
    phrases: ['prise en charge de votre colis sur notre site'],
    classified: { status: 'in_transit', stage: 'in_transit' },
  },
  {
    // Physical acceptance by the carrier, which is not the same event as the
    // shipper announcing the parcel electronically.
    phrases: ['pris en charge', 'prise en charge'],
    classified: { status: 'in_transit', stage: 'accepted' },
  },
  {
    phrases: [
      'en cours d acheminement', 'en transit', 'arrive sur l agence', 'arrive a l agence',
      'arrive au centre', 'depart de l agence', 'expedie vers', 'achemine vers',
      'expedie depuis', 'en cours de traitement sur le site', 'en route vers le point de livraison',
      // The relay could not take the parcel and it goes on to another one.
      'sollicitation client pour replace', 'relais de substitution',
    ],
    classified: { status: 'in_transit', stage: 'in_transit' },
  },
];

/** The status and stage a Mondial Relay label denotes. */
export function classifyStatus(description: string): ClassifiedStatus {
  const value = comparableText(description);
  for (const rule of MONDIAL_RELAY_WORDING) {
    if (rule.phrases.some((phrase) => value.includes(phrase))) return rule.classified;
  }
  return { status: 'unknown', stage: 'in_transit' };
}

const LAST_LEG = 'colis en route vers le point de livraison';
const OUT_FOR_DELIVERY: ClassifiedStatus = { status: 'out_for_delivery', stage: 'out_for_delivery' };

/**
 * A scan's status, given the instants of the reached milestones whose label
 * reads out for delivery. On a home delivery the carrier dates that milestone
 * at the scan that sends the parcel "en route vers le point de livraison": the
 * door, there. Only that scan, at that instant, reads out for delivery.
 */
export function classifyScan(description: string, timestamp: number, outForDelivery: ReadonlySet<number>): ClassifiedStatus {
  return comparableText(description) === LAST_LEG && outForDelivery.has(timestamp)
    ? OUT_FOR_DELIVERY
    : classifyStatus(description);
}

/**
 * The logistics site a scan names, the only place a scan states: "Prise en
 * charge de votre colis sur notre site logistique de METZ.", "Colis en cours
 * de traitement sur le site METZ", "Colis expédié depuis le site METZ". A site
 * the parcel is sent towards is not where the scan happened, and "le site
 * logistique" without "de" names none.
 */
export function scanSite(description: string): string {
  const site = /\b(?:sur notre|sur le|depuis le) site (?:logistique de )?(\p{L}[\p{L}\p{M} '’-]{1,58}?)\s*\.?$/iu
    .exec(description)?.[1]?.trim() ?? '';
  return /^logistique\b/i.test(site) ? '' : site;
}

/**
 * `SuiviParEtapes` milestone numbers, used only when no wording on the
 * shipment classified. The numbers are positions on the page's own progress
 * bar, so they are read as "at least this far".
 */
export function milestoneNumberStatus(number: number): ClassifiedStatus {
  if (number >= 5) return { status: 'delivered', stage: 'delivered' };
  if (number === 4) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  if (number >= 2) return { status: 'in_transit', stage: 'in_transit' };
  return { status: 'pending', stage: 'registered' };
}

/**
 * InPost Spain's event codes: creation (CRE), first mile (FMD), the network
 * (MMD), last mile (LMD) and end of life (EOL), each with its own Spanish
 * label. The page's bundle lists more codes than these, without meanings.
 */
const INPOST_SPAIN_CODES: ReadonlyMap<string, Stage> = new Map([
  ['CRE.1001', 'registered'],
  // Prepared, waiting for a courier to collect it from the sender.
  ['FMD.1001', 'registered'],
  ['FMD.1002', 'accepted'],
  ['MMD.1001', 'in_transit'],
  ['MMD.1004', 'in_transit'],
  ['LMD.1001', 'in_transit'],
  // At the last depot, before the Punto Pack or locker shows it ready.
  ['LMD.1002', 'in_transit'],
  ['LMD.1004', 'ready_for_pickup'],
  ['EOL.1001', 'delivered'],
] as const);

/** InPost Spain's milestones that hold only movement. */
const MOVEMENT_MILESTONES = new Set(['IN_TRANSIT', 'IN_TRANSIT_LAST_MILE']);

/** The page's headline milestones, for a parcel none of whose scans has a stage. */
const HEADLINE_MILESTONES: ReadonlyMap<string, Stage> = new Map([
  ['AT_THE_ORIGIN', 'registered'],
  ['IN_TRANSIT', 'in_transit'],
  ['IN_TRANSIT_LAST_MILE', 'in_transit'],
  ['AWAITING_COLLECTION', 'ready_for_pickup'],
  ['DELIVERED', 'delivered'],
] as const);

/** An InPost Spain scan's stage: its code, else the shared wording rules, else a movement milestone. */
export function inpostSpainStage(code: string, label: string, milestone: string): ClassifiedWording | null {
  const mapped = INPOST_SPAIN_CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  if (worded.source !== 'none') return worded;
  return MOVEMENT_MILESTONES.has(milestone) ? { stage: 'in_transit', source: 'milestone' } : null;
}

/** The stage of the page's headline milestone; a return or a failed delivery has none here. */
export function inpostSpainHeadlineStage(milestone: string): Stage | undefined {
  return HEADLINE_MILESTONES.get(milestone);
}

/**
 * What the map says about one scan. Mondial Relay's own scans carry no code, so their French
 * wording stages them; the last leg is out for delivery only when a milestone is dated at it,
 * which the stored scan does not keep. InPost Spain's scans carry their code, staged as its
 * page's parser stages them, save by the milestone the stored scan does not keep either.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code) return inpostSpainStage(code, wording, '')?.stage;
    if (comparableText(wording) === LAST_LEG) return undefined;
    const classified = classifyStatus(wording);
    return classified.status === 'unknown' ? undefined : classified.stage;
  },
  gaps: [{
    wording: LAST_LEG,
    note: 'Out for delivery when the out-for-delivery milestone is dated at it, as on a home delivery, else movement: the stored scan does not keep the milestone.',
  }],
};
