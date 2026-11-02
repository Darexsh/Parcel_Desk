import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Sailpost's status codes (`IdStato`), which its tracking service gives beside
 * each scan's Italian label. Only codes seen in replies are mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['15', 'in_transit'], // "In lavorazione": sorted at Sailpost's service centre.
  ['911', 'in_transit'], // "In Transito".
  ['931', 'in_transit'], // "Arrivata": at the delivering office.
  ['910', 'in_transit'], // "Inviata a CSR".
  ['932', 'in_transit'], // "Arrivata CSR".
  ['20', 'out_for_delivery'], // "In Consegna".
  ['200', 'failed_attempt'], // "Mancata Consegna Ass": the recipient was out.
  ['60', 'ready_for_pickup'], // "In Giacenza": held at the office for collection after a failed attempt.
  ['600', 'exception'], // "Compiuta Giacenza": not collected within the storage period.
  ['912', 'returned'], // "Inviata a Mittente", which the service files as delivered.
  ['901', 'returned'], // "Resa al Mittente", which the service files as a problem.
]);

/**
 * The service's coarse families (`CodStato`), named by the icons Sailpost's
 * app draws for them, where a family holds one milestone. Delivered (1) also
 * holds a return to the sender and a legal notice, held (3) also the end of
 * the storage period, and 7 has no clear meaning, so those fall to the wording
 * rules. A problem (99) the wording does not name stays an exception.
 */
const FAMILIES: ReadonlyMap<number, Stage> = new Map([
  [2, 'in_transit'],
  [4, 'out_for_delivery'],
  [5, 'out_for_delivery'], // Out for delivery again.
  [6, 'failed_attempt'], // The recipient was out.
  [8, 'accepted'],
  [9, 'in_transit'], // Arrived at the delivering office.
]);
const PROBLEM = 99;

// "Notificato (Ufficio)": an act counts as served ten days into storage, while the item stays at the office.
const SERVED_IN_STORAGE = '204';

/** The stage Sailpost's codes give a scan. */
export function sailpostMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else its family, else the shared wording rules, else nothing. */
export function sailpostStage(code: string, family: number, wording: string): ClassifiedWording | null {
  const mapped = sailpostMappedStage(code) ?? (code === SERVED_IN_STORAGE ? undefined : FAMILIES.get(family));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code === SERVED_IN_STORAGE) return null;
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  return family === PROBLEM ? { stage: 'exception', source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? sailpostMappedStage(code) : undefined),
  gaps: [
    { code: SERVED_IN_STORAGE, note: 'An act counts as served ten days into storage, while the item stays at the office for collection; it moves nothing.' },
  ],
};
