import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { gofoPlace, type GofoRegion } from './parser.js';

/** A scan stored with a hub's code or a town in capitals as its location takes the place the adapter now gives and keeps its row. */
export function gofoIdentityPolicy(sourceCarrierId: string, region: GofoRegion): SameInstantIdentityPolicy {
  return {
    sourceCarrierId, storedSources: [sourceCarrierId], requireProviderCode: false,
    matchEachScan: true,
    matches: (incoming, stored) => matchesRereadLocation(incoming, stored, (location) => gofoPlace(location, region)),
  };
}

export const sameInstantIdentityPolicy = gofoIdentityPolicy('gofo-fr', 'FR');
