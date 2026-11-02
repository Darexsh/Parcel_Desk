import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';

/** A UTAPI location stored with its country twice ("Hebron, KY, US, US"), written once. */
function withoutRepeatedCountry(location: string): string {
  return location.replace(/, ([A-Z]{2}), \1$/, ', $1');
}

// UTAPI scans have no code. A scan stored with its country written twice keeps
// its row, its wording and its stage, and takes the location with it once.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhl-ecommerce', storedSources: ['dhl-ecommerce'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesRereadLocation(incoming, stored, withoutRepeatedCountry),
};
