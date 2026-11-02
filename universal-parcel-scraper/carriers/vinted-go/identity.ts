import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';

/** A sorting centre's town and country as the adapter writes them, without a space before the comma. */
export function vintedGoPlace(location: string): string {
  return location.replace(/\s+,/g, ',');
}

// A scan stored with a space before its place's comma ("Example Town , FR") keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'vinted-go', storedSources: ['vinted-go'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesRereadLocation(incoming, stored, vintedGoPlace),
};
