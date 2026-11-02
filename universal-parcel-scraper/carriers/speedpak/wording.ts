import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { countryCode } from '../../core/time/index.js';

/**
 * A hand-off line can give a USPS routing barcode as the last-mile reference.
 * It opens with the recipient's ZIP code, so the line keeps only the package
 * identifier after it, and no reference when that cannot be split off.
 */
export function withoutRoutingPrefix(text: string): string {
  return text.replace(/\[(420\d{27,35})\]/g, (whole, reference: string) => {
    if (!USPS_ROUTING_BARCODE.test(reference)) return whole;
    const pic = uspsPackageIdentifier(reference);
    return pic ? `[${pic}]` : '[]';
  });
}

/**
 * A scan's place from its city and country fields. A partner's scan can give a country's
 * code as its city and the destination as its country, before the parcel leaves for it
 * (bpost's "PARCEL IS HANDLED" in Belgium, for France): the code is where the scan happened.
 */
export function speedpakPlace(city: string, country: string): string {
  if (/^[A-Z]{2}$/.test(city) && countryCode(city) === city) return city;
  return [city, country].filter(Boolean).join(', ');
}
