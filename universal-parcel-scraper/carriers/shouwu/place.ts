// The country's code a facility's name can open with, as in "CN,SAMPLE Sort Facility".
const COUNTRY_PREFIX = /^[A-Z]{2},(?=\p{L})/u;

/** A scan's place without the country's code it opens with: the facility's or the town's name. */
export function withoutCountryCode(location: string): string {
  return location.replace(COUNTRY_PREFIX, '');
}
