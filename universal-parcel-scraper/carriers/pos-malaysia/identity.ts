import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

/** Pos Malaysia gives some scans the status "In Transit" as their office. It names no place. */
export function isPosMalaysiaStatusOffice(location: string): boolean {
  return location.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US') === 'in transit';
}

// Scans stored with that label as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'pos-malaysia', storedSources: ['pos-malaysia'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isPosMalaysiaStatusOffice),
};
