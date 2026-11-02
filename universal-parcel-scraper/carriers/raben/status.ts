import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * myRaben's shipment statuses by the code that starts each key of its status
 * list (`E03_The_shipment_delivered` is `E03`). The page shows the key's
 * caption in the language it asks for; the code is the same in every one.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['E21', 'registered'], // Registered in the system: the order reached Raben.
  ['E57', 'registered'], // The truck arrived to collect the goods.
  ['E02', 'accepted'], // Collected from the sender.
  ['E08', 'in_transit'], // Loaded onto a truck.
  ['E22', 'in_transit'], // Unloaded at a depot.
  ['E43', 'in_transit'], // Unloaded in a partner's warehouse.
  ['E44', 'in_transit'], // Checked in at a warehouse.
  ['E66', 'in_transit'], // At a depot.
  ['E06', 'in_transit'], // In progress.
  ['E11', 'in_transit'], // In progress; the recipient has to be advised before delivery.
  ['E49', 'in_transit'], // In progress towards a fixed delivery day.
  ['E50', 'in_transit'], // In progress with a new delivery day.
  ['E58', 'in_transit'], // Customs cleared it.
  ['E64', 'in_transit'], // Customs released it for delivery.
  ['E59', 'customs'], // Customs clearance in progress.
  ['E60', 'customs'], // Customs clearance in progress.
  ['E63', 'customs'], // On the way to an outside customs agent.
  ['E52', 'customs'], // Held for customs clearance.
  ['E61', 'exception'], // Customs lacks the invoices.
  ['E62', 'exception'], // Customs lacks a power of attorney.
  ['E65', 'exception'], // The transit document expired.
  ['E05', 'out_for_delivery'], // On the delivery round.
  ['E56', 'out_for_delivery'], // The truck reached the delivery address.
  // Not delivered because the recipient collects it: held at the depot, ready for collection. A
  // round that follows is a change of plan, which its own rows stage.
  ['E07', 'ready_for_pickup'],
  ['E03', 'delivered'],
  ['E04', 'delivered'], // With remarks.
  ['E24', 'delivered'], // Part of the goods came back.
  ['E25', 'delivered'], // Damaged; the next two say whose side.
  ['E26', 'delivered'],
  ['E27', 'delivered'],
  ['E28', 'delivered'], // Late; the next six say whose side.
  ['E29', 'delivered'],
  ['E30', 'delivered'],
  ['E31', 'delivered'],
  ['E32', 'delivered'],
  ['E33', 'delivered'],
  ['E34', 'delivered'],
  ['E35', 'delivered'], // With discrepancies; the next two say whose side.
  ['E36', 'delivered'],
  ['E37', 'delivered'],
  ['E77', 'delivered'], // Delivered and unloaded by the driver.
  // Not delivered at the address: the recipient, the address, the papers or the order.
  ['E10', 'failed_attempt'],
  ['E13', 'failed_attempt'],
  ['E14', 'failed_attempt'],
  ['E15', 'failed_attempt'],
  ['E16', 'failed_attempt'],
  ['E18', 'failed_attempt'],
  ['E19', 'failed_attempt'],
  ['E20', 'failed_attempt'],
  ['E42', 'failed_attempt'],
  ['E53', 'failed_attempt'],
  ['E54', 'failed_attempt'],
  // Not delivered for a cause on the road: weather, a strike, a broken-down truck.
  ['E12', 'exception'],
  ['E17', 'exception'],
  ['E51', 'exception'],
  ['E72', 'exception'], // Held for the sender's instructions.
  ['E23', 'exception'], // Cancelled.
  // Not collected from the sender, for one reason or another.
  ['E01', 'exception'],
  ['E09', 'exception'],
  ['E38', 'exception'],
  ['E39', 'exception'],
  ['E40', 'exception'],
  ['E41', 'exception'],
  ['E45', 'exception'],
  ['E46', 'exception'],
  ['E47', 'exception'],
  ['E48', 'exception'],
  ['E71', 'exception'],
]);

/** Changes of plan and data that move nothing. */
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['E55', 'A new delivery day agreed with the recipient; the goods have not moved.'],
  ['E67', 'The shipment\'s data were updated; the goods have not moved.'],
  ['E68', 'A new delivery day agreed with Raben\'s customer; the goods have not moved.'],
  ['E69', 'A new collection day agreed with the sender; the goods have not moved.'],
  ['E70', 'A notice that a collection was booked; the goods have not moved.'],
]);

/** The stage Raben's map gives a status code. */
export function rabenMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A status's stage: its code, else the shared wording rules, else nothing, which keeps it visible for review. */
export function rabenStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = rabenMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? rabenMappedStage(code) : undefined),
  gaps: [...NOTICES].map(([code, note]) => ({ code, note })),
};
