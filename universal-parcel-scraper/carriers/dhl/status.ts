/**
 * DHL wording → product stage.
 *
 * DHL's public `/int-verfolgen/data` payload carries no status code: the
 * shipment history is free text in the language the lookup asks for, English
 * or German, so this map is a wording classifier rather than a code table. The
 * German wording is not a translation of the English: DHL words some scans
 * apart, such as a parcel being prepared for the delivery vehicle, which in
 * English is processed in the delivery base. Rules are
 * ordered so that a negative, a forecast or a handoff wins before the broad
 * delivery words, and anything unrecognized keeps the caller's fallback
 * instead of inventing progress.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { nonterminalEnglishReturn } from '../../core/status/language.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export function stageForText(text: string, fallback = 'in_transit'): string {
  const value = text.toLowerCase();
  // A return still to come or under way, such as a parcel left uncollected past its storage period:
  // the parcel is not back yet, so it is an exception, never its acceptance or the final return.
  if (nonterminalEnglishReturn(text) || /\bwill be (?:returned|sent back)\b|\bnot (?:been )?picked up\b|\bwird\b[^.]*\bzurück|auf dem weg zurück|\bnicht\b[^.]*\babgeholt\b/.test(value)) return 'exception';
  if (/returned to (?:the )?sender|zurück.*absender|rücksendung|retour/.test(value)) return 'returned';
  // "Delivery not possible" comes after the loading onto the delivery vehicle, before the parcel
  // waits at a retail outlet: a failed attempt, as the partner posts' copies of the scan read it.
  if (/not delivered|could not be delivered|unable to deliver|delivery attempt|delivery (?:was )?not possible|nicht.*zugestellt|zustellversuch|nicht angetroffen/.test(value)) return 'failed_attempt';
  // GENERATED equivalents of DHL's existing forecast behavior: a forecast retains
  // the structured progress fallback; it cannot establish delivery or pre-advice.
  if (/will be delivered|sera livr[ée]|wird\s+(?!zugestellt\b).+zugestellt|sar[àa] consegnat/.test(value)) return fallback;
  // Still at the delivery base, "processed in the delivery base" in English: not yet on the vehicle.
  if (/für die verladung ins zustellfahrzeug vorbereitet/.test(value)) return 'in_transit';
  const translated = trackingLanguageStage(text);
  if (translated) return translated;
  if (/ready for (?:pickup|collection)|ready to (?:collect|pick up)|awaiting collection|abholbereit|zur abholung bereit|liegt zur abholung\b[^.]*\bbereit/.test(value)) return 'ready_for_pickup';
  if (/has been delivered|was delivered|successfully delivered|^delivered\b|erfolgreich zugestellt|wurde.*zugestellt/.test(value)) return 'delivered';
  if (/^being delivered[.!]?$|out for delivery|loaded (?:into|onto).*delivery vehicle|in das zustellfahrzeug geladen|in zustellung/.test(value)) return 'out_for_delivery';
  if (/customs clearance process\b[^.]*\bhas been completed\b/.test(value)) return 'in_transit';
  if (/customs|zoll/.test(value)) return 'customs';
  if (/electronically|elektronisch|label created|shipment information|instruction data/.test(value)) return 'registered';
  // A booked collection precedes "Pick-up was successful.", so it cannot be progress beyond it.
  if (/^pick-up has been scheduled\b/.test(value)) return 'registered';
  if (/will be transported to the destination country/.test(value)) return 'in_transit';
  if (/pick-up was successful|accepted|handed (?:over|to)|has been posted by the sender|eingeliefert|übergeben|^die sendung wurde (?:von dhl )?abgeholt\b/.test(value)) return 'accepted';
  if (/processed|sorted|sorting|sortierung|bearbeitet|briefzentrum|paketzentrum|transit|transport|arrived|eingetroffen|departed/.test(value)) return 'in_transit';
  return fallback;
}

export function statusForStage(stage: string): CarrierStatus {
  if (stage === 'registered' || stage === 'pending') return 'pending';
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'failed_attempt' || stage === 'returned' || stage === 'exception') return 'exception';
  return 'in_transit';
}

/**
 * What the map says about one scan: DHL's scans carry no code, so their wording stages them as
 * the adapter reads it. Wording the rules do not know stays open, and so does a forecast, which
 * keeps the progress before it.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => (stageForText(wording, '') || undefined) as Stage | undefined,
  gaps: [],
};
