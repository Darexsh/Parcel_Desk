import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

// `PLZ` and a postcode, or `PLZ` and a country code with part of a postcode or
// none ("PLZ DE"), names the delivery area, not where the scan happened. A
// partner's scan abroad adds the country's name ("PLZ 12345, Deutschland"); a
// depot the partner names after `PLZ` instead of a postcode stays a place.
const DELIVERY_AREA = /^PLZ(?:\s*\d{4,5}|\s+[A-Z]{2}(?:\s+[A-Z\d]{1,5}){0,2})(?:,\s*\p{L}[\p{L} .'-]*)?$/iu;

/** Whether a scan place is only the delivery area Austrian Post gives as `PLZ`. */
export function isAustrianPostDeliveryArea(place: string): boolean {
  return DELIVERY_AREA.test(place.replace(/\s+/g, ' ').trim());
}

/**
 * The place of a scan: a facility keeps its name without the postcode after it,
 * and a delivery area alone gives none.
 */
export function austrianPostPlace(place: string): string {
  const name = place.replace(/,\s*PLZ\s*\d{4,5}$/i, '').trim();
  return isAustrianPostDeliveryArea(name) ? '' : name;
}

// Scans stored with a delivery area as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'austrian-post', storedSources: ['austrian-post'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isAustrianPostDeliveryArea),
};
