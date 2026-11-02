import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { ruleFits } from './rules.js';

/**
 * Domestic candidate shapes; only a matching tracking reply confirms ZTO. A rule's
 * rawPattern reads `printed`, the number as typed, which defaults to the number.
 */
export function isZtoTrackingNumber(number: string, printed = number): boolean {
  return CARRIER_DEFINITIONS.zto.detectionRules.some(rule => ruleFits(rule, number, printed));
}
