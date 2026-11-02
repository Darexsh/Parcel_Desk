import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Starex's status codes and the stage each gives a scan. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The tracker on starexglobal.com.
  ['waiting_for_confirmation', 'registered'], // The customer has to confirm the parcel before it goes on.
  ['waiting_for_delivery', 'registered'],
  ['accepted_at_facility', 'accepted'], // At Starex's warehouse abroad.
  ['export_customs_clearance', 'customs'],
  ['waiting_for_arrival', 'in_transit'], // On its way to the destination country.
  ['accepted_at_terminal', 'customs'],
  ['import_customs_clearance', 'customs'],
  ['import_customs_hold', 'customs'], // Held, under review or waiting for the customer's declaration.
  ['waiting_for_declaration', 'customs'],
  ['import_customs_released', 'customs'],
  ['sorting', 'in_transit'],
  ['in_transit', 'in_transit'],
  ['in_transit_to_transfer_center', 'in_transit'],
  ['handed_over_to_the_courier', 'out_for_delivery'],
  ['picked_up_by_courier', 'out_for_delivery'],
  ['out_for_delivery', 'out_for_delivery'],
  ['ready_for_pickup', 'ready_for_pickup'], // At the branch.
  ['delivered', 'delivered'],
  ['undelivered', 'failed_attempt'],
  // The former parcel page on starex.az.
  ['order_information_received', 'registered'],
  ['in_foreign', 'customs'],
  ['waiting_for_consolidation', 'accepted'],
  ['shipping', 'accepted'],
  ['waiting_for_delivery_tm', 'accepted'],
  ['on_the_way', 'in_transit'],
  ['on_fly', 'in_transit'],
  ['accepted_at_customs_terminal', 'customs'],
  ['domestic_customs', 'customs'],
  ['stopped_by_domestic_customs', 'customs'],
  ['pin_code_not_provided', 'exception'],
  ['customs_cleared', 'customs'],
  ['exited_customs', 'customs'],
  ['domestic_warehouse', 'in_transit'],
  ['on_driver', 'in_transit'],
  ['in_delivery_point', 'ready_for_pickup'],
  ['on_courier', 'out_for_delivery'],
  ['received_by_customer', 'delivered'],
  ['delivered_to_return_facility', 'returned'],
]);

const GAPS = [
  { code: 'waiting_for_payment', note: "Starex's map leaves it unmapped on purpose: it asks the customer to pay the delivery fee and says nothing of where the parcel is." },
  { code: 'delivery_delayed', note: "Starex's map leaves it unmapped on purpose: it says the delivery is late, not where the parcel is." },
];
const GAP_CODES = new Set(GAPS.map(({ code }) => code));

/** The stage Starex's status code gives a scan. */
export function starexMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else nothing for a code left out on purpose, else the shared wording rules. */
export function starexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = starexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAP_CODES.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries its code: the map reads it, whatever the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? starexMappedStage(code) : undefined),
  gaps: GAPS,
};
