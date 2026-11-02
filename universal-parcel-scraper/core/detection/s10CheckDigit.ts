/**
 * The UPU S10 check digit of a nine-digit serial, on its own so that
 * normalization can read it without importing the validators in s10.ts.
 */

/** The ninth of nine digits checks the first eight: weights 8, 6, 4, 2, 3, 5, 9, 7, then 11 minus the sum mod 11. */
export function hasS10CheckDigit(digits: string): boolean {
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const rawCheckDigit = 11 - (sum % 11);
  const expected = rawCheckDigit === 10 ? 0 : rawCheckDigit === 11 ? 5 : rawCheckDigit;
  return Number(digits[8]) === expected;
}
