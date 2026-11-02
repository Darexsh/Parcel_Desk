import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Mauritius Post's tracker names each scan in English, without a code. Only
 * wording seen on the tracker is mapped; another falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['received from customer', 'accepted'],
  ['received the shipment from customer', 'accepted'], // The same scan's earlier wording.
  // Printed at the posting office, the header's origin, after the item was
  // received from the customer; an earlier wording spelt it "Pacakge".
  ['receipt label printed', 'accepted'],
  ['pacakge label printed', 'accepted'],
  ['dispatched', 'in_transit'],
  ['receive an item at office of delivery', 'in_transit'],
  ['received from bag', 'in_transit'], // Taken out of the mail bag at the office.
  // The notice asking the addressee to collect the item at the office.
  ['delivery notification generated', 'ready_for_pickup'],
  ['delivered through counter', 'delivered'],
]);

/** The stage the map gives Mauritius Post's wording, if it knows it. */
export function mauritiusPostScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function mauritiusPostStage(wording: string): ClassifiedWording | null {
  const mapped = mauritiusPostScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mauritiusPostScanStage(wording)),
  gaps: [],
};
