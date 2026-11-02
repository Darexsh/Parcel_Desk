/**
 * Domestic references printed below Royal Mail's 2D barcodes. The 21-character
 * form is two hexadecimal characters, seven digits and twelve hexadecimal
 * characters; outside the common 32 prefix it needs a letter, since 21 digits
 * are also another carrier's numbers. The 16-character form is hexadecimal.
 */
export function isRoyalMailDomesticReference(number: string): boolean {
  return /^(?:32\d{11}[A-F0-9]{8}|(?=[A-F0-9]*[A-F])[A-F0-9]{2}\d{7}[A-F0-9]{12}|(?=[A-F0-9]*[A-F])(?=[A-F0-9]*\d)[A-F0-9]{16})$/.test(number);
}
