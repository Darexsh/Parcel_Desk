import { normalizeTrackingNumber } from './normalize.js';

// USPS Publication 199, sections 4.1–4.6: the routing AI and ZIP precede
// the PIC, and only the PIC participates in its alternating MOD10 check.
// Channel 95 is USPS retail and 91 the legacy tracking construct; both are
// read only at 22 digits, so a ZIP+4 add-on starting 91 or 95 never makes a
// 34-digit scan ambiguous.
// https://postalpro.usps.com/pub199
function validPic(number: string): boolean {
  if (!/^(?:9[1-5]\d{20}|9[2-4]\d{24})$/.test(number)) return false;
  let sum = 0;
  for (let i = number.length - 1; i >= 0; i--) {
    sum += Number(number[i]) * ((number.length - 1 - i) % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** The ship-to AI 420 and a five- or nine-digit ZIP before a 22- or 26-digit PIC, by length alone. */
export const USPS_ROUTING_BARCODE = /^420(?:\d{5}|\d{9})(?:\d{22}|\d{26})$/;

// Publication 199, sections 1.4 and 4.3: channel 92 carries a nine-digit
// Mailer ID, which starts with 9, and 93 a six-digit one, which starts with 0
// to 8; the legacy 91 has its nine-digit Mailer ID after a two-digit service
// code. Online 94 and retail 95 PICs can carry either length.
const MAILER_ID_LAYOUT = /^(?:91\d{2}9|92\d{3}9|93\d{3}[0-8]|9[45])/;

/**
 * A whole IMpb, with an optional five- or nine-digit routing ZIP. A 34-digit
 * scan reads as a ZIP5 and a 26-digit PIC or a ZIP9 and a 22-digit one. When
 * both readings pass the check digit, the one whose Mailer ID fits its channel
 * is the identifier; if both or neither fit, there is none.
 */
export function uspsPackageIdentifier(raw: string): string | null {
  const number = normalizeTrackingNumber(raw);
  if (validPic(number)) return number;
  if (!USPS_ROUTING_BARCODE.test(number)) return null;
  const readings = [number.slice(8), number.slice(12)].filter(validPic);
  if (readings.length < 2) return readings[0] ?? null;
  const laidOut = readings.filter((pic) => MAILER_ID_LAYOUT.test(pic));
  return laidOut.length === 1 ? laidOut[0]! : null;
}

export function isValidUspsPackageBarcode(raw: string): boolean {
  return uspsPackageIdentifier(raw) !== null;
}
