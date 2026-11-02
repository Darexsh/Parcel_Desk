/**
 * Deutsche Post Identcode check digit, and DHL eCommerce Poland's use of it.
 *
 * What it is: the check used by the `"identcode"` detection rule on DHL
 * Paket's 12-digit parcel numbers, which are otherwise shared with FedEx,
 * Japan Post, Sagawa and others, and by the `"dhl-ecommerce-pl"` rule on
 * DHL eCommerce Poland's 11-digit numbers, shared with GLS, PPL and others.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the digits-only shape test.
 */

/** Weights 4, 9, 4, … from the left, and the ten's complement of the sum as the last digit. */
function hasIdentcodeCheckDigit(value: string): boolean {
  const sum = [...value.slice(0, -1)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 9 : 4), 0);
  return (10 - (sum % 10)) % 10 === Number(value.at(-1));
}

/**
 * Eleven digits and a modulo-10 check digit: weights 4, 9, 4, … from the
 * left, and the ten's complement of the sum, 0 when the sum is a multiple of
 * ten (Deutsche Post's Identcode and Leitcode check, as paketda.de's
 * "Paket-Prüfziffern" gives it for 12-digit DHL parcel numbers).
 */
export function isValidDhlIdentcode(value: string): boolean {
  return /^\d{12}$/.test(value) && hasIdentcodeCheckDigit(value);
}

/**
 * Ten digits and the same check digit. DHL eCommerce Poland does not publish
 * it; every number archived from its trackers passes it.
 */
export function isValidDhlEcommercePolandNumber(value: string): boolean {
  return /^\d{11}$/.test(value) && hasIdentcodeCheckDigit(value);
}
