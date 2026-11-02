/**
 * UPS-style check digits.
 *
 * What it is: the check UPS prints at the end of its `1Z` numbers, and the same
 * arithmetic on OnTrac's 15-character numbers.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */

/** A digit keeps its value; a letter counts as its ASCII code minus 63, mod 10 (A = 2, …, I = 0, …, Z = 7). */
export function upsCharacterValue(character: string): number {
  return /\d/.test(character) ? Number(character) : (character.charCodeAt(0) - 63) % 10;
}

/** Weights 1, 2, 1, … from the left, plain products, and ten's complement. */
function upsCheckDigit(payload: string): number {
  const sum = [...payload].reduce((total, character, index) => total + upsCharacterValue(character) * (index % 2 ? 2 : 1), 0);
  return (10 - sum % 10) % 10;
}

/** `1Z`, fifteen characters and a check digit over those fifteen. */
export function isValidUpsTrackingNumber(value: string): boolean {
  return /^1Z[0-9A-Z]{15}\d$/.test(value) && upsCheckDigit(value.slice(2, 17)) === Number(value[17]);
}

/** OnTrac's `C` or `D` and fourteen digits: the letter counts as 4 or 5 in the UPS check over everything but the last digit. */
export function isValidOnTracTrackingNumber(value: string): boolean {
  return /^[CD]\d{14}$/.test(value) && upsCheckDigit(value.slice(0, 14)) === Number(value[14]);
}
