import { normalizeTrackingNumber } from './normalize.js';

/**
 * Placeholder numbers: the zeros, repeated digits and 123456789 runs typed to
 * try a form, and example numbers that say so. Many trackers file test labels
 * and stray scans under them and show those shipments to anyone who asks, so
 * lookups refuse them.
 * What it is not: detection still reads the shape, and a carrier's own checks
 * still decide whether it issues the number.
 */

const ASCENDING = '0123456789'.repeat(5);
const DESCENDING = '9876543210'.repeat(5);

const isRun = (digits: string) => ASCENDING.includes(digits) || DESCENDING.includes(digits);

/**
 * Whether the number is a placeholder rather than one a carrier issued: apart
 * from a letter prefix and suffix, six or more digits that repeat one digit or
 * run straight up or down, or a run of nine or more with one digit after it, as
 * a check digit would be. An S10 item is read by its serial without the check
 * digit, so the UPU's own example, RR123456785…, is one too. So is the word
 * EXAMPLE with digits around it, such as an app's demo parcel.
 */
export function isPlaceholderNumber(raw: string): boolean {
  const number = normalizeTrackingNumber(raw);
  if (/^\d*EXAMPLE\d*$/.test(number)) return true;
  const digits = /^[A-Z]{2}(\d{8})\d[A-Z]{2}$/.exec(number)?.[1] ?? /^[A-Z]*(\d{6,})[A-Z]*$/.exec(number)?.[1];
  if (digits === undefined) return false;
  return /^(\d)\1+$/.test(digits) || isRun(digits) || (digits.length >= 10 && isRun(digits.slice(0, -1)));
}
