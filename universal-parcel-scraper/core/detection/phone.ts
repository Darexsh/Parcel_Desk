import type { CarrierId } from '../../generated/catalog.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { CHECKSUMS } from './checksums.js';
import { normalizeTrackingNumber } from './normalize.js';
import { ruleFits } from './rules.js';

/**
 * Phone numbers typed as tracking numbers: a mobile number written as it is
 * dialled in the reader's country. No carrier issues them, so recognition asks
 * none about one.
 * What it is not: no reading without the country, and no format a carrier
 * serving that country prints. A number that a rule of such a carrier, or of
 * one without a country, accepts with its check digit is never a phone number.
 */

// Mobile numbers as dialled at home, by country: only formats no carrier
// serving the country issues.
const MOBILE_NUMBERS: Readonly<Record<string, RegExp>> = {
  // Paraguay: the trunk 0, then 9, an operator's range and six digits.
  PY: /^09(?:6[13]|7[1-6]|8[1-6]|9[1-5])\d{6}$/,
};

/**
 * Whether the number is a mobile number of `country` (ISO 3166-1 alpha-2), the
 * reader's, in its domestic format, such as a Paraguayan 0 and nine digits.
 * False without a country, and for a number a carrier serving the country, or
 * one without a country, could have issued.
 */
export function isPhoneNumber(raw: string, country?: string | null): boolean {
  const code = country?.trim().toUpperCase() ?? '';
  const pattern = MOBILE_NUMBERS[code];
  if (!pattern) return false;
  const number = normalizeTrackingNumber(raw);
  if (!pattern.test(number)) return false;
  const printed = raw.trim().toUpperCase();
  return !(Object.keys(CARRIER_DEFINITIONS) as CarrierId[]).some((carrier) => {
    const { countries = [], detectionRules } = CARRIER_DEFINITIONS[carrier];
    return (countries.length === 0 || countries.includes(code)) && detectionRules.some((rule) =>
      ruleFits(rule, number, printed) && (!rule.checksum || CHECKSUMS[rule.checksum](number)));
  });
}
