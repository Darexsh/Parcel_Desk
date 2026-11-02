import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { ruleFits } from './rules.js';

/**
 * A customer parcel ID ("ID collo cliente") of EOB and seventeen digits. The
 * sender applies it, so its rule stays low confidence: recognition asks BRT,
 * whose parcel search finds it.
 */
export function isBrtCustomerParcelId(number: string): boolean {
  return /^EOB\d{17}$/.test(number);
}

/**
 * Complete identifiers accepted by BRT's shipment-number and parcel-label requests. A
 * rule's rawPattern reads `printed`, the number as typed, which defaults to the number.
 */
export function isBrtTrackingNumber(number: string, printed = number): boolean {
  return CARRIER_DEFINITIONS.brt.detectionRules.some(rule => ruleFits(rule, number, printed));
}
