/**
 * Poste Italiane status vocabulary.
 *
 * DoveQuando has no per-event status code: `statoLavorazione` is Italian prose,
 * so the map matches on normalized wording (whitespace collapsed, lower-cased
 * with the `it-IT` locale). The vocabulary is explicitly still being observed,
 * so unmapped wording yields no stage at all: the sync classifies it and
 * records where the final stage came from, rather than this map guessing.
 *
 * Provenance: derived from the prior-art client
 * https://github.com/ha-parcel-integrations/ha-poste-italiane (MIT), whose
 * success vocabulary was confirmed against a real parcel on 2026-08-24; the
 * ASCII-apostrophe delivered variant was observed live on 2026-09-11.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Collapse whitespace and lower-case with the Italian locale, as the map expects. */
export function normalizePosteItalianeWording(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('it-IT') : '';
}

/**
 * The milestone the official page heads a movement with, by the movement's `box`
 * (`boxConstants` in the page's results controller).
 */
const BOX_LABELS = new Map([
  ['2', 'Presa in carico'], ['3', 'In transito'], ['4', 'In consegna'], ['5', 'Consegnata'], ['6', 'In restituzione al mittente'],
]);

/** The ends of sentences whose start the box gives, as registered mail words its movements. */
const FRAGMENT = /^(?:da un nostro operatore\b|a seguito di acquisto\b|con successo\b|presso il paese estero\b|all['’]estero$|in data$)/u;

/**
 * A movement's wording as a sentence. Registered mail gives only the end of one:
 * "da un nostro operatore presso l'Ufficio Postale" follows the box's label, and
 * "in data" leads in the date the page prints after it. The movement reads as the
 * label and the rest, without that lead-in, since its time carries the date. Other
 * wording, or a fragment without a known box, stays as it is.
 */
export function posteItalianeMovementWording(wording: string, box: unknown): string {
  const label = typeof box === 'string' || typeof box === 'number' ? BOX_LABELS.get(String(box).trim()) : undefined;
  if (!label || !FRAGMENT.test(normalizePosteItalianeWording(wording))) return wording;
  const rest = wording.replace(/\s*\bin data$/iu, '').trim();
  return rest ? `${label} ${rest}` : label;
}

/** Every sentence a fragment can become, one per box: how a stored fragment reads now. */
export function posteItalianeMovementWordings(wording: string): string[] {
  return [...BOX_LABELS.keys()].map(box => posteItalianeMovementWording(wording, box)).filter(sentence => sentence !== wording);
}

/** The stage and status for one `statoLavorazione`, or undefined when unmapped. */
export function classifyPosteItalianeStatus(rawWording: unknown): ClassifiedStatus | undefined {
  const value = normalizePosteItalianeWording(rawWording);
  if (!value) return undefined;
  // Dropped off at a Punto Poste, or taken in by one of Poste's operators at a post office counter or
  // from the sender's home, also on its own line: the parcel itself is in Poste's hands.
  if (value.startsWith('la spedizione è stata presa in carico presso il punto poste')
    || value.startsWith('la spedizione è stata presa in carico da un nostro operatore')
    || value.startsWith('presa in carico da un nostro operatore')
    || value.startsWith('da un nostro operatore presso')) return { status: 'in_transit', stage: 'accepted' };
  // A purchase on poste.it, and the bare line, which names no intake.
  if (value.startsWith('la spedizione è stata presa in carico')
    || value === 'presa in carico a seguito di acquisto da poste.it'
    || value === 'a seguito di acquisto da poste.it') return { status: 'pending', stage: 'registered' };
  // Registered mail's movements under the page's labels (`posteItalianeMovementWording`).
  if (value === 'in transito' || value === 'in transito presso il paese estero'
    || value === 'in transito all’estero' || value === 'in transito all\'estero') return { status: 'in_transit', stage: 'in_transit' };
  if (value === 'in consegna') return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  if (value === 'consegnata con successo') return { status: 'delivered', stage: 'delivered' };
  if (value.startsWith('la spedizione è in transito')
    || value.startsWith('completata la fase di verifica per lo svincolo')
    || value.startsWith('consegna non andata a buon fine')) {
    return value.startsWith('consegna non andata a buon fine')
      ? { status: 'exception', stage: 'failed_attempt' }
      : { status: 'in_transit', stage: 'in_transit' };
  }
  // A round that failed, with the working day the next one starts from: not that coming round.
  if (value.startsWith('non è stato possibile effettuare la consegna')) return { status: 'exception', stage: 'failed_attempt' };
  if (value.startsWith('in restituzione al mittente')) return { status: 'exception', stage: 'returned' };
  // Registered mail held at a post office from the date the line gives.
  if (value.startsWith('la spedizione sarà disponibile per il ritiro')) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  switch (value) {
    case 'la spedizione è in consegna':
      return { status: 'out_for_delivery', stage: 'out_for_delivery' };
    case 'la spedizione è stata consegnata':
    // ASCII-apostrophe variant observed live on a delivered parcel.
    case "la spedizione e' stata consegnata":
    case 'con successo in data':
      return { status: 'delivered', stage: 'delivered' };
    case 'all’estero':
    case 'all\'estero':
    case 'presso il paese estero in data':
    case 'in data':
    // A change to the delivery instructions: the parcel carries on.
    case 'cambio disposizioni di consegna':
      return { status: 'in_transit', stage: 'in_transit' };
    case 'sono in corso delle verifiche sulla spedizione. contatta assistenza':
      return { status: 'exception', stage: 'failed_attempt' };
    case 'disponibile per il ritiro dal giorno lavorativo successivo alla data indicata':
    // A parcel left at a PuntoPoste or locker, to collect within the time the notice gives.
    case 'disponibile per il ritiro entro i termini indicati su sms/email':
      return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
    default:
      return undefined;
  }
}

/** What the map says about one scan: DoveQuando's wording carries no code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => classifyPosteItalianeStatus(wording)?.stage,
  gaps: [],
};
