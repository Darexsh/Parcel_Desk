import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Central Transport's statuses, in the summary and the history rows alike.
 * They carry no code; only wording seen in replies or quoted from the
 * tracker is mapped, and other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['picked up', 'accepted'],
  ['out for delivery', 'out_for_delivery'],
  ['attempted to deliver', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['delivered.', 'delivered'],
]);

// The summary's status for a shipment the tracker has nothing more to say
// about, which the page shows in red; old shipments end on it.
const CONTACT = 'contact customer service at (586) 467-1900.';

/** The stage the map gives a status's wording, if it knows it. */
export function centralTransportMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/**
 * A status's stage: the map, else the row's service exception flag, which
 * the page marks with a warning, else the shared wording rules, else nothing.
 */
export function centralTransportStage(wording: string, serviceException: boolean): ClassifiedWording | null {
  const mapped = centralTransportMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (serviceException) return { stage: 'exception', source: 'carrier_map' };
  if (normalizeStatusWording(wording) === CONTACT) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)),
  gaps: [
    { wording: CONTACT, note: 'The summary\'s status for a shipment the tracker can say nothing more about, old ones included; it moves nothing.' },
  ],
};
