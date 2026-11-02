import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * FedEx Freight's scan codes (`statusCD`), as its tracking reply sends them
 * with the page's own wording. Only codes seen in replies are mapped; another
 * code falls to the shared wording rules. A shipment exception, such as a
 * weather delay, is filed as one even when later scans move the freight on.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OC', 'registered'], // Shipment information sent to FedEx Freight: the bill of lading, before pickup.
  ['PU', 'accepted'], // Picked up.
  ['DP', 'in_transit'], // Left origin facility.
  ['IT', 'in_transit'], // On the way, at a terminal along the route.
  ['AF', 'in_transit'], // At local facility: the delivering terminal.
  ['OD', 'out_for_delivery'],
  ['SE', 'exception'], // Shipment exception; its details give the reason.
  ['DL', 'delivered'],
]);

// "At delivery": the driver arrived at the consignee's site (`AR` with the
// exception code `DARV`), between out for delivery and the delivery. Other
// arrivals, at a terminal, keep to the shared wording rules.
const AT_DELIVERY = 'DARV';
const AT_DELIVERY_WORDING = /^at delivery(?::|$)/;

function arrivedForDelivery(code: string, exceptionCode: string, wording: string): boolean {
  return code.toUpperCase() === 'AR' && (exceptionCode.toUpperCase() === AT_DELIVERY || AT_DELIVERY_WORDING.test(normalizeStatusWording(wording)));
}

/** The stage FedEx Freight's codes give a scan code. */
export function fedexFreightMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/**
 * A scan's stage: its code, the driver's arrival at the consignee, else the
 * shared wording rules, else nothing.
 */
export function fedexFreightStage(code: string, exceptionCode: string, wording: string): ClassifiedWording | null {
  const mapped = fedexFreightMappedStage(code) ?? (arrivedForDelivery(code, exceptionCode, wording) ? 'out_for_delivery' : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan by its code and wording; an arrival's exception code is not asked here, so its wording stands for it. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code
    ? fedexFreightMappedStage(code) ?? (arrivedForDelivery(code, '', wording) ? 'out_for_delivery' : undefined)
    : undefined),
  gaps: [],
};
