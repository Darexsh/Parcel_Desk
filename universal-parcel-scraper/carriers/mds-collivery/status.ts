import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The lines the tracking page writes for Collivery's own steps, which carry
 * no code. Each answers one of the statuses in Collivery's API documentation:
 * the documentation's status history for one waybill and the page's history
 * for the same waybill agree to the minute.
 */
const LINES: readonly (readonly [RegExp, Stage])[] = [
  [/^collivery loaded on system$/, 'registered'], // Waiting Client Acceptance: booked, not yet collected.
  [/^received in (?:.+ )?branch$/, 'in_transit'], // Received By Branch, at collection or on the way.
  [/^en route to destination$/, 'in_transit'], // In Transit.
  [/^driver assigned to deliver your parcel$/, 'in_transit'], // Delivery Driver Allocated; the driver has not left yet.
  [/^the delivery attempt of your parcel failed because /, 'failed_attempt'], // Delivery Failed, with its reason.
  [/^collivery cancelled$/, 'exception'], // Collivery Cancelled.
];

// Collivery Modified and Invoiced: a booking change and billing, which move nothing.
const QUIET = ['parcel details updated', 'collivery invoiced'];

/** The stage the map gives a line of the page's history. */
export function colliveryMappedStage(wording: string): Stage | undefined {
  const line = normalizeStatusWording(wording);
  return LINES.find(([pattern]) => pattern.test(line))?.[1];
}

/** A scan's stage: its line in the map, else the shared wording rules; a booking change or billing has none. */
export function colliveryStage(wording: string): ClassifiedWording | null {
  const mapped = colliveryMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (QUIET.includes(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The status names of Collivery's API documentation, which the page gives as
 * the current status over the history. The history leaves some of them out,
 * such as the driver leaving with the parcel or its completion.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map(([
  ['Waiting Client Acceptance', 'registered'],
  ['Waiting Payment', 'registered'],
  ['Quote Accepted', 'registered'],
  ['Processing Order', 'registered'],
  ['Collection Courier Allocated', 'registered'],
  ['Collection Driver Allocated', 'registered'],
  ['Collection Driver Dispatched', 'registered'],
  ['Collection Courier Dispatched', 'registered'],
  ['Collection Failed', 'registered'], // The parcel still waits to be collected.
  ['Collected', 'accepted'],
  ['In Transit', 'in_transit'],
  ['In transit - Pre-scheduled', 'in_transit'],
  ['Received By Branch', 'in_transit'],
  ['In branch - Pre-scheduled', 'in_transit'],
  ['Received By Courier', 'in_transit'], // Handed to a partner courier.
  ['Delivery Courier Allocated', 'in_transit'],
  ['Delivery Driver Allocated', 'in_transit'],
  ['Unhold', 'in_transit'],
  ['Delivery Driver Dispatched', 'out_for_delivery'],
  ['Delivery Courier Dispatched', 'out_for_delivery'],
  ['Delivery Failed', 'failed_attempt'],
  ['Delivered', 'delivered'],
  ['POD Received', 'delivered'],
  ['Completed', 'delivered'],
  ['Collivery Cancelled', 'exception'],
  ['On Hold', 'exception'],
  ['Pending Investigation', 'exception'],
  ['Delayed', 'exception'],
] as const).map(([name, stage]) => [normalizeStatusWording(name), stage]));

/** The stage of the page's current status; billing and booking changes (Invoiced, Collivery Modified) have none. */
export function colliveryStatusStage(name: string): Stage | undefined {
  return STATUSES.get(normalizeStatusWording(name));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => colliveryMappedStage(wording),
  gaps: [
    { wording: 'parcel details updated', note: 'The booking was changed (Collivery Modified); the parcel does not move.' },
    { wording: 'collivery invoiced', note: 'The booking was invoiced, after its completion or cancellation; billing moves nothing.' },
  ],
};
