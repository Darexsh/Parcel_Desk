import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Shipa Delivery's status codes, which its lookup sends with each status's
 * name. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Order Created: the shop made the order.
  ['2', 'registered'], // Pending Pickup Confirmation: logged with the order, before any pickup.
  ['4', 'registered'], // Scheduled For Pickup.
  ['5', 'registered'], // Out For Pickup: a courier is on the way to collect it.
  ['6', 'registered'], // On The Way To Pickup Location.
  ['7', 'registered'], // Arrived At Pickup Location.
  ['8', 'exception'], // Pickup Failed, with the reason.
  ['81', 'exception'], // Pickup Attempt Failed, with the reason.
  ['11', 'accepted'], // Pickup Completed: collected from the shop, or from the airport after customs.
  ['42', 'in_transit'], // Received By Origin Hub.
  ['43', 'in_transit'], // Received By Sorting Hub.
  ['12', 'in_transit'], // Received By Destination Hub.
  ['36', 'in_transit'], // Arrived Destination Airport: an import has landed.
  ['40', 'in_transit'], // Received By Port Of Entry.
  ['30', 'customs'], // Customs Clearance - In Progress.
  ['33', 'in_transit'], // Customs Clearance - Complete.
  ['15', 'in_transit'], // Scheduled For Delivery: the next round after a failed one.
  ['16', 'out_for_delivery'], // Out For Delivery.
  ['17', 'out_for_delivery'], // On The Way To Delivery Location.
  ['18', 'out_for_delivery'], // Arrived At Delivery Location.
  ['82', 'failed_attempt'], // Delivery Attempt Failed, with the reason.
  ['20', 'failed_attempt'], // Delivery Failed, with the reason.
  ['19', 'delivered'], // Delivered.
  ['23', 'returned'], // Scheduled For Return: the return to the shop is decided.
  ['24', 'returned'], // Out For Return.
  ['25', 'returned'], // Return Arrived.
  ['26', 'returned'], // Returned.
]);

/** Codes the service logs a second after the status before them; they move nothing. */
const FOLLOW_UPS: ReadonlyMap<string, string> = new Map([
  ['13', 'Pending Delivery Confirmation follows the pickup within a second, before any hub scan: a system step, not a movement.'],
  ['22', 'Rescheduled follows a failed attempt within a second and records the date the customer chose; the attempt itself carries the stage.'],
]);

/** The stage Shipa Delivery's status codes give a status. */
export function shipaMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A status's stage: its code, else the shared wording rules, else nothing. A follow-up code has none. */
export function shipaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = shipaMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (FOLLOW_UPS.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? shipaMappedStage(code) : undefined),
  gaps: [...FOLLOW_UPS].map(([code, note]) => ({ code, note })),
};
