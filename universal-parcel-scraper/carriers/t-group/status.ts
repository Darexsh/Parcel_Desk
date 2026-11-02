import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan wordings of Tgroup's tracker, which carries no codes. Only
 * wordings seen on the tracker or quoted from it are mapped; another falls to
 * the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Nuova Spedizione Creata', 'registered'],
  // The pickup from the sender is put on a driver's round; Tgroup does not have the parcel yet.
  ['Ritiro Assegnato Al Giro Di Distribuzione', 'registered'],
  ['In Partenza Da Centro Smistamento', 'in_transit'],
  // The delivery appointment still has to be booked by phone.
  ['Prenotazione telefonica da effettuare', 'in_transit'],
  // Handed to the driver's delivery round.
  ['Affidata Al Giro Consegna', 'out_for_delivery'],
  ['Spedizione Consegnata', 'delivered'],
  ['rifiutata dal destinatario', 'failed_attempt'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function tGroupMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function tGroupStage(wording: string): ClassifiedWording | null {
  const mapped = tGroupMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => tGroupMappedStage(wording),
  gaps: [],
};
