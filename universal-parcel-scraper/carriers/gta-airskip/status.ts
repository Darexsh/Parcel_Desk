import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GTA AirSkip's standard statuses, the ids replies carry beside each scan and
 * the shipment. The tracking page reads their names and descriptions from its
 * own list; every id on that list is mapped except the delay notices.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['4', 'exception'], // Address Issue
  ['5', 'in_transit'], // Ready for Delivery: at the local station, assigned to a driver.
  ['6', 'exception'], // Damaged in Transit; it cannot be delivered.
  ['7', 'returned'], // Returning to Merchant
  ['8', 'in_transit'], // In Transit
  ['9', 'registered'], // Label Created: the parcel is still with the merchant.
  ['10', 'failed_attempt'], // Delivery Attempted
  ['11', 'accepted'], // Package Received
  ['12', 'out_for_delivery'], // Out for Delivery, also on the load scan onto the delivery vehicle.
  ['13', 'delivered'],
  ['14', 'exception'], // Refused by Customer
  ['15', 'exception'], // Lost in Transit
  ['16', 'exception'], // Cancelled by the merchant.
  ['17', 'customs'], // Customs Hold
  ['18', 'in_transit'], // Customs Released
  ['19', 'exception'], // Damaged; to be returned to the merchant.
  ['20', 'out_for_delivery'], // Next for Delivery
  ['21', 'returned'], // Returned to Merchant, also on the return scans that lead there.
  ['22', 'failed_attempt'], // Unsuccessful Delivery Attempt
  ['30', 'accepted'], // Received At Sort Hub
  ['31', 'returned'], // Return At Hub: the page says the parcel went back to the merchant.
  ['32', 'in_transit'], // In Transit
  ['33', 'exception'], // Damage
  ['34', 'in_transit'], // Transfer
  ['35', 'in_transit'], // Package Redirected
]);

// Weather Delay, General Delay and Service Limitations: notices that the parcel is late.
const NOTICES = new Set(['1', '2', '3']);

/**
 * Scan names replies carry without a standard status: older scans, and the
 * terminal scans named after their status and reason, such as "Loaded on
 * Truck: Normal Status", whose reason after the colon is left out here.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['order received', 'registered'],
  ['label created', 'registered'],
  ['received at sort hub', 'accepted'],
  ['inscanned at location', 'accepted'],
  ['in transit', 'in_transit'],
  ['received from prior carrier', 'in_transit'], // The first terminal scan after GTA AirSkip's own.
  ['arrived at terminal location', 'in_transit'],
  ['package redirected', 'in_transit'],
  ['assigned to last mile driver for delivery', 'in_transit'],
  ['load scan', 'out_for_delivery'],
  ['loaded on truck', 'out_for_delivery'],
  ['driver out for delivery', 'out_for_delivery'],
  ['you are next', 'out_for_delivery'],
  ['attempted delivery ai shipment has been reconsigned', 'failed_attempt'], // Not delivered; the reason follows.
  ['undelivered', 'failed_attempt'],
  ['completed unloading at delivery location', 'delivered'],
  ['delivered', 'delivered'],
  ['rto', 'returned'], // Return to origin.
  ['return at hub', 'returned'],
]);

/** A scan's name, without the status or reason after its first colon. */
const nameOf = (wording: string) => wording.split(':')[0]!.toLowerCase().replace(/\s+/g, ' ').trim();

/** The stage GTA AirSkip's own standard status, else its scan name, gives a scan; a delay notice gets none. */
export function gtaAirskipMappedStage(code: string, wording: string): Stage | undefined {
  const id = code.trim();
  if (NOTICES.has(id)) return undefined;
  return CODES.get(id) ?? NAMES.get(nameOf(wording));
}

/** A scan's stage: its standard status or name, else the shared wording rules, else nothing. */
export function gtaAirskipStage(code: string, wording: string): ClassifiedWording | null {
  if (NOTICES.has(code.trim())) return null;
  const mapped = gtaAirskipMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => gtaAirskipMappedStage(code ?? '', wording),
  gaps: [
    { code: '1', note: 'Weather Delay: a notice that the parcel is late; it moves nothing.' },
    { code: '2', note: 'General Delay: a notice that the parcel is late; it moves nothing.' },
    { code: '3', note: 'Service Limitations: a notice that the parcel is late; it moves nothing.' },
  ],
};
