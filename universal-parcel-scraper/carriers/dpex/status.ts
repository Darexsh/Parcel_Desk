import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event numbers DPEX's tracker tags each scan with. Only numbers seen
 * in replies are mapped; another number falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'delivered'],
  ['2', 'accepted'], // Collection: picked up from the sender.
  ['3', 'in_transit'], // In Transit to Destination.
  ['4', 'in_transit'], // Arrived Hub.
  ['10', 'customs'], // Customs processing.
  ['15', 'out_for_delivery'],
  ['37', 'in_transit'], // Released from Customs.
  ['40', 'in_transit'], // Arrived Depot, at the delivering station.
  ['82', 'failed_attempt'], // Attempted Delivery - Rescheduled Delivery: the parcel went out again days later.
  ['90', 'registered'], // Documentation Prepared, before the collection.
  ['91', 'registered'], // Shipment Finalised, before the collection.
  ['97', 'failed_attempt'], // Attempted Delivery - Consignee Not Available.
]);

/** The stage DPEX's event numbers give a scan. */
export function dpexMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

const GAPS: CarrierStatusMap['gaps'] = [];
const UNSTAGED = new Set(GAPS.map((gap) => gap.code));

/** A scan's stage: its event number, else the shared wording rules, else nothing. */
export function dpexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = dpexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? dpexMappedStage(code) : undefined),
  gaps: GAPS,
};
