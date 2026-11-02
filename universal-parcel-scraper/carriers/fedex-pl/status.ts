import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event codes of FedEx Poland's tracking service. Only codes seen in
 * replies are mapped; another code falls to the wording below.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PKL', 'accepted'], // The courier collected the shipment from the sender.
  // At a FedEx branch or hub, all worded "Przesyłka w oddziale FedEx.".
  ['PK', 'in_transit'],
  ['WG.O', 'in_transit'],
  ['SR.P', 'in_transit'],
  ['WG.S', 'in_transit'],
  ['WE', 'in_transit'],
  ['WK', 'out_for_delivery'], // Given to a courier for delivery.
  ['AV', 'failed_attempt'], // Not delivered; a notice was left.
  ['DS', 'delivered'],
]);

/**
 * The service's own wording, which every scan carries, for a code the map does
 * not know. The shared rules read no Polish.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['przesyłka przygotowana przez nadawcę do odbioru przez kuriera fedex.', 'registered'],
  ['kurier odebrał przesyłkę od nadawcy.', 'accepted'],
  ['przesyłka w oddziale fedex.', 'in_transit'],
  ['przesyłka wydana do doręczenia kurierowi fedex.', 'out_for_delivery'],
  // The courier brought the shipment back to the branch undelivered; it can go out again.
  ['zwrot przesyłki przez kuriera do oddziału fedex.', 'failed_attempt'],
  ['nieudana próba doręczenia. odbiorca odmówił przyjęcia przesyłki.', 'failed_attempt'],
  ['nieudana próba doręczenia. przesyłka awizowana.', 'failed_attempt'],
  ['kurier doręczył przesyłkę do odbiorcy.', 'delivered'],
  ['przesyłka doręczona do odbiorcy.', 'delivered'],
  ['zwrot przesyłki do nadawcy.', 'returned'],
]);

/** An instruction to change the delivery date: a request, not a movement. */
const RESCHEDULED = 'dyspozycja zmiany terminu doręczenia';

/**
 * The shipment's overall `status`, which the page lists beside the number.
 * Other words are not read.
 */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map([
  ['w oddziale fedex', 'in_transit'],
  ['wydana do doręczenia', 'out_for_delivery'],
  ['doręczona', 'delivered'],
]);

/** The stage FedEx Poland's codes or wording give a scan, if any. */
export function fedexPlMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** The stage the overall status gives the shipment, if it is one the map knows. */
export function fedexPlSummaryStage(status: string): Stage | undefined {
  return SUMMARIES.get(normalizeStatusWording(status));
}

/** A scan's stage: its code, else its wording, else the shared wording rules, else nothing. */
export function fedexPlStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fedexPlMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording).replace(/\.$/, '') === RESCHEDULED) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => fedexPlMappedStage(code, wording),
  gaps: [
    { wording: RESCHEDULED, note: 'An instruction to change the delivery date, which the former tracker listed among the scans; it moves nothing.' },
  ],
};
