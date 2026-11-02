/**
 * Ciblex action wording → product stage.
 *
 * The public parcel page prints one French action label per scan row and no
 * status code, so the map is phrase-based. Phrases are compared after
 * lower-casing, stripping diacritics and collapsing everything that is not a
 * letter or a digit, which makes the accented and unaccented spellings the
 * portal alternates between ("Colis Livré" / "COLIS LIVRE") the same key.
 *
 * Order matters: return and delivery phrases are tested before the broader
 * transit ones. Rows whose wording is not mapped keep a neutral description
 * and no carrier-declared stage beyond the transit default, so the sync's
 * wording classifier records them for review.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/text.js';
import type { Stage } from '../../generated/catalog.js';

export interface ClassifiedCiblexStatus {
  status: CarrierStatus;
  stage: Stage;
  description: string;
}

/** Lower-case, unaccent and reduce a French label to letters, digits and single spaces. */
export function comparableText(value: string): string {
  return clean(value)
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The parcel's contractual transit time, "Acheminement contractuel du colis en 48h00", printed
 * beside a depot scan. It describes the service, not a step, so it has no stage and does not
 * decide the parcel's status.
 */
export function isCiblexNotice(rawDescription: string): boolean {
  return /^acheminement contractuel du colis en \d{1,3}h\d{0,2}$/.test(comparableText(rawDescription));
}

function includesAny(value: string, phrases: string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

const UPDATE: ClassifiedCiblexStatus = { status: 'unknown', stage: 'in_transit', description: 'Ciblex tracking update' };
const RETURNED: ClassifiedCiblexStatus = { status: 'exception', stage: 'returned', description: 'Returned to sender' };
const DELIVERED: ClassifiedCiblexStatus = { status: 'delivered', stage: 'delivered', description: 'Delivered' };
const OUT_FOR_DELIVERY: ClassifiedCiblexStatus = { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' };
const READY_FOR_PICKUP: ClassifiedCiblexStatus = { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup' };
const EXCEPTION: ClassifiedCiblexStatus = { status: 'exception', stage: 'exception', description: 'Shipment exception' };
const FAILED_ATTEMPT: ClassifiedCiblexStatus = { status: 'exception', stage: 'failed_attempt', description: 'Delivery issue' };
const IN_TRANSIT: ClassifiedCiblexStatus = { status: 'in_transit', stage: 'in_transit', description: 'Parcel processed at Ciblex facility' };
const ACCEPTED: ClassifiedCiblexStatus = { status: 'in_transit', stage: 'accepted', description: 'Shipment collected' };
const REGISTERED: ClassifiedCiblexStatus = { status: 'pending', stage: 'registered', description: 'Shipment information received' };

export function classifyCiblexStatus(rawDescription: string): ClassifiedCiblexStatus {
  const value = comparableText(rawDescription);
  if (/\b(?:prevu|prevue|demain|prochainement|sera|seront|doit|doivent)\b/.test(value)
    || /\b(?:pas|jamais)\b/.test(value)) {
    return UPDATE;
  }
  if (includesAny(value, ['retour expediteur', 'retourne a l expediteur', 'retour a l expediteur'])) {
    return RETURNED;
  }
  if (includesAny(value, ['colis livre', 'livraison effectuee', 'remis au destinataire'])) {
    return DELIVERED;
  }
  if (includesAny(value, ['mis en livraison', 'mise en livraison', 'en cours de livraison'])) {
    return OUT_FOR_DELIVERY;
  }
  if (includesAny(value, ['disponible en relais', 'disponible au relais', 'mis a disposition'])) {
    return READY_FOR_PICKUP;
  }
  if (includesAny(value, [
    'complement adresse',
    'adresse incorrecte',
    'incident',
    'anomalie',
    'refuse',
  ])) {
    return EXCEPTION;
  }
  if (includesAny(value, ['destinataire absent', 'non livre'])) {
    return FAILED_ATTEMPT;
  }
  if (includesAny(value, ['colis controle', 'colis en transit', 'arrive agence', 'depart agence'])) {
    return IN_TRANSIT;
  }
  if (includesAny(value, ['colis pris en charge', 'prise en charge'])) {
    return ACCEPTED;
  }
  if (includesAny(value, ['annonce', 'information recue'])) {
    return REGISTERED;
  }
  return UPDATE;
}

/** The stage of the English wording the adapter stores for each label it reads. */
const STORED = new Map([RETURNED, DELIVERED, OUT_FOR_DELIVERY, READY_FOR_PICKUP, EXCEPTION, FAILED_ATTEMPT, IN_TRANSIT, ACCEPTED, REGISTERED]
  .map(({ description, stage }) => [normalizeStatusWording(description), stage]));

/**
 * What the map says about one scan: the English wording the adapter stores in place of a label
 * it reads, or a copy's French label. A label it does not read is stored as "Ciblex tracking
 * update", which stays open since the stored scan does not keep the label.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const classified = classifyCiblexStatus(wording);
    return STORED.get(wording) ?? (classified.status === 'unknown' ? undefined : classified.stage);
  },
  gaps: [],
};
