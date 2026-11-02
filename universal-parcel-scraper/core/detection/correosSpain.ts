const CHECK_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * The letter that closes a Correos parcel or expedition code: the character
 * codes before it, summed, pick it from the Spanish tax-id letter table.
 * Correos publishes no formula; this one holds across the public codes in the
 * number corpus. It cannot see two characters swapped. `PR` codes ending in
 * `C` do not use it.
 */
export function isValidCorreosSpainCheckLetter(number: string): boolean {
  let sum = 0;
  for (let index = 0; index < number.length - 1; index++) sum += number.charCodeAt(index);
  return number.length > 1 && CHECK_LETTERS[sum % CHECK_LETTERS.length] === number.at(-1);
}

/**
 * A Correos expedition code: the product letters, label code and nine digits
 * its parcel code starts with, closed by its own check letter. Parcel codes
 * carry seven more digits before theirs.
 */
export function isCorreosSpainExpeditionCode(number: string): boolean {
  return /^[PD][A-Z][A-Z0-9]{4}\d{9}[A-Z]$/.test(number) && isValidCorreosSpainCheckLetter(number);
}
