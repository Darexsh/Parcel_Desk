import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * XLCourier's event types, `tracking_event_status_id` in the tracking page's
 * reply, from its published tracking status list. Another type falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['100', 'registered'], // Created: the parcel's details are in, the parcel is not.
  ['200', 'registered'], // Scheduled for pickup.
  ['300', 'registered'], // Out for pickup.
  ['400', 'registered'], // Pickup failed: the courier has not collected the parcel yet.
  ['500', 'accepted'], // Picked up.
  ['600', 'in_transit'], // Received at a depot or the national hub.
  ['700', 'in_transit'], // Pending transfer from the national hub.
  ['800', 'in_transit'], // Left the national hub.
  ['900', 'in_transit'], // Scheduled for delivery.
  ['1000', 'out_for_delivery'],
  ['1100', 'failed_attempt'],
  ['1200', 'returned'], // Scheduled for return.
  ['1300', 'returned'], // On its way back to the sender.
  ['1400', 'returned'], // A return attempt that did not reach the sender; still going back.
  ['1500', 'returned'],
  ['1570', 'exception'], // Destroyed.
  ['1600', 'delivered'],
]);

/** The stage XLCourier's event types give a scan. */
export function xlcourierMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

/** A scan's stage: its event type, else the shared wording rules, else nothing. */
export function xlcourierStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = xlcourierMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? xlcourierMappedStage(code) : undefined),
  gaps: [],
};
