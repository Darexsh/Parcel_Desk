import { normalizeTrackingNumber } from '../../core/detection/normalize.js';

/** Yodel's layouts, the network that became InPost UK: JJD or JD, 8YDR, or the label layout. */
export const INPOST_UK_NUMBER = /^(?:J?JD\d{16}|8YDR\d{9}|\d{2}[A-Z]{3}\d{7}A\d{3})$/;

/**
 * InPost UK's page for a number in one of Yodel's layouts, where Yodel's former
 * tracker now forwards it. The Polish page does not find these numbers.
 */
export function inpostUkTrackingUrl(raw: string): string | undefined {
  const number = normalizeTrackingNumber(raw);
  return INPOST_UK_NUMBER.test(number)
    ? `https://inpost.co.uk/tracking/result?parcel_code=${encodeURIComponent(number)}`
    : undefined;
}
