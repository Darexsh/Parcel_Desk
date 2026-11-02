import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's rows carry wording only. The booking and transhipment tables
 * give dates under column headings, which the adapter words "Booked",
 * "Despatched to {station}" and "Arrived". The delivery table gives the result
 * of each delivery run in English: a delivery, or why the parcel stayed. Only
 * wording seen on the tracker is mapped; other wording falls to the shared
 * rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['booked', 'accepted'],
  ['arrived', 'in_transit'],
  ['shipment delivered', 'delivered'],
  // Handed on for an out-of-delivery-area locality; the delivery is confirmed later.
  ['forwarded to oda location, pod awaited', 'in_transit'],
  // The reasons a delivery run left the parcel, under the column's "Attempted Date".
  ['others', 'failed_attempt'],
  ['incomplete documentation', 'failed_attempt'],
  ['customer required open delivery', 'failed_attempt'],
  // The delivery station has the paperwork but not the goods.
  ['document received, consignment not received', 'exception'],
]);
const DESPATCHED = /^despatched to \S/;

/** The stage the map gives a row's wording, if it knows it. */
export function tciExpressMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (DESPATCHED.test(key) ? 'in_transit' : undefined);
}

/** A row's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function tciExpressStage(wording: string): ClassifiedWording | null {
  const mapped = tciExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tciExpressMappedStage(wording)),
  gaps: [],
};
