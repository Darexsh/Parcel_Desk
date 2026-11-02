import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Speedaf's scan `action` codes. The labels come from the action list in
 * Speedaf's WooCommerce plugin; 80, 191, 350, 361, 375 and 376 are codes its
 * tracker uses that the plugin does not list.
 */
const ACTIONS: ReadonlyMap<string, Stage> = new Map([
  ['10', 'registered'], // Booked.
  ['-10', 'exception'], // Cancelled.
  ['150', 'accepted'], // Booked in at a Chinese warehouse.
  ['181', 'in_transit'], // Packed into a bag.
  ['190', 'in_transit'], // Out of the warehouse.
  ['191', 'in_transit'], // Handed over for the flight.
  ['402', 'customs'], // Export declaration.
  ['220', 'in_transit'], // Flight departed.
  ['230', 'in_transit'], // Flight arrived.
  ['350', 'customs'], // Collected from the airport for import clearance.
  ['360', 'customs'], // Import clearance, a duty to pay, or a customs query.
  ['361', 'customs'], // Duty paid; clearance goes on.
  ['401', 'exception'], // Customs exception.
  ['370', 'in_transit'], // Cleared.
  ['375', 'in_transit'], // Delivered to the central warehouse in the destination country.
  ['376', 'in_transit'], // Arrived at a Speedaf distribution centre.
  ['80', 'in_transit'], // Held for a stock count; the tracker words it "In Transit".
  // Collected. Parcels from China get it at the destination's first site,
  // after clearance, so it is movement there and not a first acceptance.
  ['1', 'in_transit'],
  ['2', 'in_transit'], // Departed a site or distribution centre.
  ['3', 'in_transit'], // Arrived at a site or distribution centre.
  ['4', 'out_for_delivery'],
  ['16', 'ready_for_pickup'], // Booked in at a third-party pickup point.
  ['18', 'ready_for_pickup'], // Arrived at a Speedaf pickup site, to collect with a code.
  ['5', 'delivered'], // Signed for, at the door or at a pickup site.
  ['-710', 'exception'], // Being returned.
  ['730', 'returned'], // Back at the warehouse that returns it.
]);

/** Issue scans (-1), by the reason in their sub-action. */
const ISSUES: ReadonlyMap<string, Stage> = new Map([
  ['-1:IP05', 'exception'], // The recipient refused the parcel.
  ['-1:IP06', 'failed_attempt'], // The recipient had the delivery moved to another day.
  ['-1:5577', 'customs'], // The recipient has not paid the duty yet.
]);

/** The stage Speedaf's codes give a scan code, `action` or `action:subAction`. */
export function speedafMappedStage(code: string): Stage | undefined {
  return ISSUES.get(code) ?? ACTIONS.get(code.replace(/:.*$/, ''));
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function speedafStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = speedafMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? speedafMappedStage(code) : undefined),
  gaps: [
    { code: '-1', note: 'An issue scan without a reason in its sub-action. The plugin labels the action invalid.' },
    { code: '-2', note: 'The page hides these scans unless the waybill carries its exception flag; their meaning is not documented.' },
  ],
};
