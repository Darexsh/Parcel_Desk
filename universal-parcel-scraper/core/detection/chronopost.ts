import { isValidS10TrackingNumber } from './s10.js';

// Chronopost's own postal-shaped codes: its dedicated prefixes, and suffixes
// that name one of its services rather than a country.
const OWN_CODE = /^(?:PZ|XR|XT|XU|XW|XY)|(?:JB|JF|TS|RV|VF)$/;

/**
 * Another post's letter or parcel item, which Chronopost may scan in one of
 * its hubs on the way. Chronopost delivers EMS, French items and its own
 * codes itself, whatever their shape.
 */
export function isAnotherPostItemAtChronopost(number: string): boolean {
  return isValidS10TrackingNumber(number) && !number.endsWith('FR') && !number.startsWith('E') && !OWN_CODE.test(number);
}
