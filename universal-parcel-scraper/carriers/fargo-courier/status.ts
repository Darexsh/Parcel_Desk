import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Fargo's event codes. The wording after them names the waybill, the parcel,
 * the linehaul manifest or the delivery run, so the code is the key. Only
 * codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['WBLCRE', 'registered'], // Waybill created; an account customer's system can create it before the parcel is handed over.
  ['WBLALL', 'in_transit'], // Allocated to a linehaul manifest at the sending branch.
  ['WBLLIN', 'in_transit'], // On the linehaul, or in transit on its manifest.
  ['WBLDAL', 'in_transit'], // Scanned into the receiving depot from the manifest.
  ['DELCRE', 'out_for_delivery'], // The parcel scanned onto a delivery run.
  ['WBLALD', 'out_for_delivery'], // The waybill allocated to a delivery run.
  ['WBLDLV', 'delivered'],
  ['PODCRE', 'delivered'], // The proof of delivery recorded, after the delivery.
]);

/** The invoicing of the waybill to the sender's account: billing, not a scan. */
export const FARGO_COURIER_INVOICE = 'WBLINV';

/** The stage Fargo's code gives a scan. */
export function fargoCourierMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function fargoCourierStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fargoCourierMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? fargoCourierMappedStage(code) : undefined),
  gaps: [],
};
