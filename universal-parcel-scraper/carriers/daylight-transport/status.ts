import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of a row of Daylight's shipment history, its `discreteStatus`.
 * Rows carry no code. Only wording seen in replies is mapped; other wording
 * falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['pickup requested', 'registered'],
  // The freight bill opened for the shipment, before or after the pickup request.
  ['freight bill entered', 'registered'],
  // The driver reached the shipper; the freight is not collected yet.
  ['arrived at shipper', 'registered'],
  ['picked up', 'accepted'],
  // The freight reached the origin terminal's dock, after a pickup or when the shipper brings it in.
  ['docked at origin', 'accepted'],
  ['enroute to destination', 'in_transit'],
  ['arrived at destination', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // The driver reached the consignee, minutes before the delivery.
  ['arrived at consignee', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

// The consignee's delivery appointment: needed, then made. Rows of either come at any point of a
// shipment, even before its pickup, and move nothing.
const APPOINTMENTS = ['appointment required', 'appointment made'];

/** The stage the map gives Daylight's wording, if it knows it. */
export function daylightMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A row's stage: the map, else nothing for an appointment, else the shared wording rules, else nothing. */
export function daylightStage(wording: string): ClassifiedWording | null {
  const mapped = daylightMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (APPOINTMENTS.includes(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : daylightMappedStage(wording)),
  gaps: APPOINTMENTS.map((wording) => ({ wording,
    note: 'The consignee\'s delivery appointment, needed or made; it can come before the pickup and moves nothing.' })),
};
