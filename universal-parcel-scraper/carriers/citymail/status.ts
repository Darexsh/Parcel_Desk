import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's scan wordings that replies showed. Scans come without a code;
 * another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The sender booked the delivery or sent its pre-advice; CityMail does not have the parcel yet.
  ['Vi har fått beställning på en leverans till dig och väntar på ditt paket', 'registered'],
  ['Vi har fått en beställning på en leverans och väntar på paketet', 'registered'],
  ['Paketet har aviserats, men ännu inte lämnats in till CityMail', 'registered'],
  ['Försändelsen har aviserats, men ännu inte lämnats in till CityMail', 'registered'],
  ['Paketet har ankommit till terminal', 'in_transit'],
  ['Paket har ankommit till vår terminal', 'in_transit'],
  // Sorted for a delivery round, sometimes days before the estimated date, so not out for delivery.
  ['Paketet förbereds för leverans', 'in_transit'],
  ['Paketet är på väg till ombud', 'in_transit'],
  // At the service point (ombud), for the recipient to collect.
  ['Paketet har levererats till ombud', 'ready_for_pickup'],
  ['Paketet är utdelat, vid dörr/finns i påse på brevlåda', 'delivered'],
  ['Paketet har levererats hem till dig', 'delivered'],
  ['Paketet har levererats till din brevlåda/postfack', 'delivered'],
  // The courier took the parcel back to the CityMail office.
  ['Leveransen kunde inte genomföras, brevlåda saknades på adressen', 'failed_attempt'],
  ['Namn saknades på adressen - leveransen kunde inte genomföras', 'failed_attempt'],
  // Not collected from the service point in time; on its way back to the sender.
  ['Paketet hämtades inte ut i tid och skickas tillbaka till avsändaren', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan wording. */
export function citymailMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function citymailStage(wording: string): ClassifiedWording | null {
  const mapped = citymailMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : citymailMappedStage(wording)),
  gaps: [],
};
