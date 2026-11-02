/**
 * DPD parcel number check character.
 *
 * What it is: the character DPD prints after the fourteen-digit parcel number on
 * its labels and notification cards, so a typed label reads as fifteen characters.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** ISO/IEC 7064 MOD 37,36 over the fourteen digits. */
function checkCharacter(digits: string): string {
  let remainder = 36;
  for (const digit of digits) {
    remainder += Number(digit);
    if (remainder > 36) remainder -= 36;
    remainder *= 2;
    if (remainder > 36) remainder -= 37;
  }
  return ALPHABET[(37 - remainder) % 36]!;
}

/** Fourteen digits followed by their matching check character: what the `"dpd"` detection rules require. */
export function isValidDpdParcelNumber(value: string): boolean {
  return /^\d{14}[0-9A-Z]$/.test(value) && value[14] === checkCharacter(value.slice(0, 14));
}

/**
 * The fourteen-digit parcel number DPD's tracking takes, from the number alone
 * or followed by its check character. A character that does not match is a typo,
 * not another parcel.
 */
export function dpdParcelNumber(value: string): string | null {
  const match = /^(\d{14})([0-9A-Z])?$/.exec(value);
  if (!match) return null;
  if (match[2] !== undefined && match[2] !== checkCharacter(match[1]!)) return null;
  return match[1]!;
}
