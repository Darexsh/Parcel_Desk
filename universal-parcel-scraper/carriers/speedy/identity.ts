import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { speedyPlace } from './place.js';

/** A scan stored with its site's type before the town takes the town alone and keeps its row. */
export function speedyIdentityPolicy(sourceCarrierId: string): SameInstantIdentityPolicy {
  return {
    sourceCarrierId, storedSources: [sourceCarrierId], requireProviderCode: false,
    matchEachScan: true,
    matches: (incoming, stored) => matchesRereadLocation(incoming, stored, speedyPlace),
  };
}

export const sameInstantIdentityPolicy = speedyIdentityPolicy('speedy');
