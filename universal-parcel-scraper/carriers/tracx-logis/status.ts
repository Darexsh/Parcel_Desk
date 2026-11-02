import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TracX Logis's scan codes: the older two-letter ones, which its own code
 * labels, and the newer ones its tracker sends with their wording. A scan
 * with a reason has the code `code:reason`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['N1', 'registered'], // Received Shipping Order.
  ['P0', 'registered'], // Generating the waybill.
  ['P1', 'registered'], // Pickup requested.
  ['P2', 'registered'], // Manifested for pickup.
  ['PA', 'registered'], // Pickup assigned to a driver.
  ['PS', 'registered'], // Pickup started.
  ['RE', 'registered'], // Pickup reassigned.
  ['P3', 'accepted'], // Pickup Done.
  ['D2', 'in_transit'], // Received at Collection Center.
  ['SI', 'in_transit'], // Released from Collection Center, towards the destination country.
  ['M50', 'in_transit'], // Arrival in Destination Country.
  ['SA', 'in_transit'],
  ['M70', 'customs'], // Customs Clearance Initiated in Destination Country.
  ['IC', 'customs'], // In customs.
  ['CH', 'customs'], // Held in customs clearance.
  ['M80', 'in_transit'], // Customs Clearance Completed in Destination Country.
  ['AO', 'in_transit'],
  ['AI', 'in_transit'],
  ['L10', 'in_transit'], // Handover/Receipt Completed by Delivery Company.
  ['L40', 'in_transit'], // Linehaul Loading (Transfer to Delivery Point).
  ['L50', 'in_transit'], // Linehaul Unloading.
  ['L70', 'in_transit'], // In Transit, between the delivery company's sites.
  ['L20', 'out_for_delivery'], // Delivery Started.
  ['L60', 'out_for_delivery'], // Departure for Delivery to Customer.
  ['D3', 'out_for_delivery'], // Starting Delivery to Recipient.
  ['D4', 'delivered'], // Delivery Completed.
  ['DX', 'failed_attempt'], // Delivery Failed, sometimes with the reason.
  ['LK', 'exception'], // Kept in the warehouse for long-term storage, with the reason.
  ['RD', 'returned'], // On its way back to the sender.
  ['RT', 'returned'], // Back with the sender.
  ['D9', 'returned'],
]);

/** The reason that turns a delivery round, or a delivery, into the return to the sender. */
const RETURN_TO_ORIGIN = 'RO';

/** The stage TracX Logis's codes give a scan code, `code` or `code:reason`. */
export function tracxMappedStage(code: string): Stage | undefined {
  const [base = '', reason] = code.trim().toUpperCase().split(':');
  const stage = CODES.get(base);
  if (reason === RETURN_TO_ORIGIN && (stage === 'out_for_delivery' || stage === 'delivered')) return 'returned';
  return stage;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function tracxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = tracxMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? tracxMappedStage(code) : undefined),
  gaps: [],
};
