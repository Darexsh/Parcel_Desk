import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Oak Harbor's trace details: each history row's action and the
 * delivery status over it. Neither carries a code. The parser drops the
 * signer's name a delivery row ends with, so the map sees "Delivered".
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['picked up', 'accepted'],
  // A partner carrier handed the freight to Oak Harbor.
  ['received from partner', 'accepted'],
  ['leaving terminal', 'in_transit'],
  ['arrived at terminal', 'in_transit'],
  ['in transit between terminals', 'in_transit'],
  ['at destination terminal', 'in_transit'],
  // The terminal asked the consignee for a delivery appointment.
  ['delivery appointment requested', 'in_transit'],
  // An appointment set with the consignee, as the delivery status.
  ['appointment', 'in_transit'],
  ['dispatched for delivery', 'out_for_delivery'],
  // The consignee collects the freight at the terminal.
  ['will call', 'ready_for_pickup'],
  // The consignee refused the delivery.
  ['refused-not delivered', 'failed_attempt'],
  ['delivered', 'delivered'],
]);

// A history row for an appointment names its day and window: "Appointment-4/09/20 14:00-17:00".
const APPOINTMENT = /^appointment\s*-\s*\d/;

/** The stage the map gives Oak Harbor's wording, if it knows it. */
export function oakHarborMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.get(normalized) ?? (APPOINTMENT.test(normalized) ? 'in_transit' : undefined);
}

/**
 * A row's or the delivery status's stage from the map, else from the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function oakHarborStage(wording: string): ClassifiedWording | null {
  const mapped = oakHarborMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : oakHarborMappedStage(wording)),
  gaps: [],
};
