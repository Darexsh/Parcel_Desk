/**
 * Deutsche Post Frankier-ID check character.
 *
 * What it is: the check used by the `"frankier-id"` detection rule on the
 * twenty-character identity of a letter franked through Deutsche Post's
 * machine-readable postage, which its tracking takes as the letter's number.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */

/**
 * Nineteen characters and a hexadecimal check character: CRC-4 (CCITT,
 * polynomial x⁴ + x + 1, starting from zero) over the characters as ASCII
 * bytes, most significant bit first, as Deutsche Post's "Maschinenlesbare
 * Freimachungsvermerke – DV-Freimachung" specification (6.2) defines it.
 */
export function isValidFrankierId(value: string): boolean {
  if (!/^[0-9A-Z]{19}[0-9A-F]$/.test(value)) return false;
  let crc = 0;
  for (let index = 0; index < 19; index++) {
    const byte = value.charCodeAt(index);
    for (let bit = 7; bit >= 0; bit--) {
      const carry = (crc >> 3) ^ ((byte >> bit) & 1);
      crc = (crc << 1) & 0xf;
      if (carry) crc ^= 0x3;
    }
  }
  return crc === parseInt(value[19]!, 16);
}
