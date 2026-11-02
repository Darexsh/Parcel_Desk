import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Anjun's scan codes (`stateCode`), which the tracker spells with stray spaces
 * and mixed case, as `LM _has _collected`: the map reads them in lower case
 * without spaces. The first group came in replies; the second is named by the
 * tracking page's script, which sorts parcels by them. Another code falls to
 * the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['forecast', 'registered'], // The sender's data, before the parcel.
  ['arrive_at_warehouse', 'accepted'], // "The goods have arrived at Anjun", at its warehouse in China.
  ['leave_warehouse', 'in_transit'],
  ['leave_orgin_place', 'in_transit'], // Sic: departed the origin city.
  ['arrived_at_airline', 'in_transit'],
  ['air_take_off', 'in_transit'],
  ['arrival_at_destination_airport', 'in_transit'],
  ['custody_receipt', 'in_transit'], // Received at the courier terminal in the destination country.
  ['tfk_has_been_scanned', 'customs'], // Entered the bonded warehouse for clearance.
  ['customs_detention', 'customs'], // Held for, or sent to, customs review.
  ['in_customs_clearance', 'customs'],
  ['customs_clearance_completed_and_released', 'in_transit'],
  ['clearance_successful', 'in_transit'],
  ['post_office_of_destination_country', 'in_transit'], // Received by the destination post.
  ['released_for_collection', 'in_transit'], // Collected from customs by the last-mile network.
  ['lm_has_collected', 'in_transit'],
  ['transit_warehouse_arrived', 'in_transit'],
  ['transit_warehouse_is_packed', 'in_transit'],
  ['transit_warehouse_sent', 'in_transit'],
  ['delivering', 'in_transit'], // On the way to, or between, sorting centres.
  ['delivery_point_reception', 'in_transit'], // At the delivery station the courier leaves from.
  ['to_be_delivered', 'out_for_delivery'],
  ['delivery_failed', 'failed_attempt'],
  // Back to a sorting centre after failed deliveries; the parcel can still go out again.
  ['returns_being_shipped_to_warehouse', 'exception'],
  ['delivered', 'delivered'],
  ['transport', 'in_transit'],
  ['clearance_start', 'customs'],
  ['customs_buckle', 'customs'], // Held by customs.
  ['tax_to_be_paid', 'customs'],
  ['customs_pay_tax', 'customs'],
  ['customs_paid', 'customs'],
  ['clearance_failed', 'exception'],
  ['tax_failure', 'exception'],
  ['arrive_to_collect', 'ready_for_pickup'], // The page files it as arrived and waiting for collection.
  ['return_to_sender', 'returned'],
  ['send_back', 'returned'],
  ['parcel_damaged', 'exception'],
  ['lost', 'exception'],
  ['destroy', 'exception'],
  ['abnormal', 'exception'],
]);

/** A code as the map reads it: lower case, without spaces. */
export function anjunCodeKey(code: string): string {
  return code.replace(/\s+/g, '').toLowerCase();
}

/** The stage Anjun's codes give a scan code. */
export function anjunMappedStage(code: string): Stage | undefined {
  return CODES.get(anjunCodeKey(code));
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function anjunStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = anjunMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: anjunCodeKey,
  stage: (code) => (code ? anjunMappedStage(code) : undefined),
  gaps: [],
};
