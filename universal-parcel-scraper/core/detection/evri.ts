/**
 * Evri 16-character parcel number check digit.
 *
 * What it is: the check used by the `"evri"` detection rules. Evri publishes no
 * specification; every Evri number in the public reports checked passes it.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */
import { upsCharacterValue } from './ups.js';

/**
 * `H` or `T`, five letters or digits, ten digits. The first fifteen characters,
 * valued as UPS values letters, weigh 2, 1, 2, … from the left; the sum mod 10
 * is the last digit, with no complement.
 */
export function isValidEvriParcelNumber(value: string): boolean {
  if (!/^[HT][0-9A-Z]{5}\d{10}$/.test(value)) return false;
  const sum = [...value.slice(0, 15)].reduce((total, character, index) => total + upsCharacterValue(character) * (index % 2 ? 1 : 2), 0);
  return sum % 10 === Number(value[15]);
}
