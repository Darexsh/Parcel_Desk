import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings D Express's tracker gives its scans and its current status,
 * which carry no code, in `normalizeStatusWording` form. Another wording falls
 * to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The sender booked the shipment and waits for the courier to collect it.
  ['čeka na preuzimanje', 'registered'],
  ['pošiljka je preuzeta od pošiljaoca', 'accepted'],
  // A courier took the shipment out on the day's delivery round.
  ['pošiljka zadužena za isporuku', 'out_for_delivery'],
  ['pošiljka je isporučena primaocu', 'delivered'],
  ['pošiljka se vraća pošiljaocu', 'returned'],
  ['pošiljka je vraćena pošiljaocu', 'returned'],
  // The former tracker page's status lines, and its lines for where the shipment is.
  ['pošiljka je preuzeta', 'accepted'],
  ['pošiljka preuzeta', 'accepted'],
  ['ponovni pokušaj isporuke, nema nikoga na adresi', 'failed_attempt'],
  // Delivery put off by agreement with the recipient; the shipment went back to the centre.
  ['isporuka odložena u dogovoru sa primaocem', 'failed_attempt'],
  ['pošiljka je isporučena', 'delivered'],
  ['pošiljka isporučena', 'delivered'],
  ['pošiljka vraćena pošiljaocu', 'returned'],
]);

// The recipient chose a parcel locker on the tracking page; the shipment moves on with its next scan.
const REDIRECT = 'preusmerena na paketomat';

/** The stage D Express's map gives a wording in `normalizeStatusWording` form. */
export function dexpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else nothing for a redirect, else the shared wording rules. */
export function dexpressStage(wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  const mapped = dexpressMappedStage(normalized);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalized === REDIRECT) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => dexpressMappedStage(wording),
  gaps: [
    { wording: REDIRECT, note: 'The recipient chose a parcel locker on the tracking page instead of the door; the shipment moves on with its next scan.' },
  ],
};
