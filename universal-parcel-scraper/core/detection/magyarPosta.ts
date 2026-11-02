/**
 * Magyar Posta domestic number check digit.
 *
 * What it is: the check used by the `"magyar-posta"` detection rule. The MPL
 * API documentation shows the numbers without a specification; its examples
 * and every public number checked pass it.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */

/**
 * `P`, a product letter, a three-character customer code, seven digits and a
 * check digit. The seven digits weigh 3, 1, 3, … from the left; the sum mod 10
 * is the last digit, with no complement. The code is outside the check.
 */
export function isValidMagyarPostaNumber(value: string): boolean {
  if (!/^P[A-Z][0-9A-Z]{3}\d{8}$/.test(value)) return false;
  const sum = [...value.slice(5, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return sum % 10 === Number(value[12]);
}
