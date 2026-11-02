import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';
import { swissPostRevoked } from './status.js';

/** A site number or postcode stored as the whole location of a scan with no town or country. */
const bareNumber = (location: string) => /^\d+$/.test(location);

/**
 * The tracker words a scan in its reader's language. With the code the policy
 * requires, the instant and the place, it is the scan stored in another
 * wording, unless one of the two is revoked and the other not.
 */
function reworded(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return incoming.location.trim() === stored.location.trim()
    && swissPostRevoked(incoming.description) === swissPostRevoked(stored.description);
}

// The destination post's scans of a parcel sent abroad came with Swiss Post's
// Zurich offset until October 2026, and now show the destination's when it
// keeps one clock. A scan stored with a bare number as its location loses it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'swiss-post', storedSources: ['swiss-post'], requireProviderCode: true,
  matchEachScan: true,
  matches: (incoming, stored) => reworded(incoming, stored) || matchesLocationEnrichment(incoming, stored)
    || matchesDroppedLocation(incoming, stored, bareNumber),
  relabelledFrom: 'Europe/Zurich',
};
