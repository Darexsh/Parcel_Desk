/**
 * Colissimo ID13 check digit.
 *
 * What it is: the key Colissimo prints as the 13th character of its parcel
 * numbers, used by the `"colissimo"` detection rule.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */
import { hasGs1CheckDigit } from './numericChecksums.js';

/**
 * A two-character product code, ten digits and their GS1 mod 10 key; the
 * product code is not part of the check (Colissimo's GeoLabel national
 * format, section 2.3).
 */
export function isValidColissimoParcelNumber(value: string): boolean {
  return /^[0-9A-Z]{2}\d{11}$/.test(value) && hasGs1CheckDigit(value.slice(2));
}
