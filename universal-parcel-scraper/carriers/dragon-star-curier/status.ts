import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The codes DSC's tracker puts before some scans' wording, as "PRL - Preluata". */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PRL', 'accepted'], // Picked up from the sender.
  ['EIA', 'exception'], // "Exceptie in Asteptare": a problem holds the parcel.
]);

/**
 * DSC's wordings, without diacritics: its scans', and the steps of the
 * page's progress bar, which head the Status box as the parcel's phase.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['generata', 'registered'], // The AWB was issued; nothing was picked up yet.
  ['preluata', 'accepted'],
  ['intrare centru', 'in_transit'], // Arrived at a hub.
  ['iesire centru', 'in_transit'], // Left a hub.
  ['in tranzit', 'in_transit'],
  ['in livrare', 'out_for_delivery'],
  ['exceptie in asteptare', 'exception'],
  ['livrat', 'delivered'],
  ['livrata', 'delivered'],
  ['returnat', 'returned'],
  ['returnata', 'returned'],
]);

/** Lower case, single spaces and no diacritics, so "Preluată" and "Preluata" read alike. */
function wordingKey(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');
}

/** The stage DSC's map gives a scan's code, else its wording. */
export function dragonStarCurierMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.trim().toUpperCase()) : undefined) ?? WORDINGS.get(wordingKey(wording));
}

/** A scan's stage: DSC's map, else the shared wording rules, else nothing. */
export function dragonStarCurierStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = dragonStarCurierMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => dragonStarCurierMappedStage(code, wording),
  gaps: [],
};
