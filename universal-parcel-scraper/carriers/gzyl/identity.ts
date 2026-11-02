import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { hualeiScanText } from './text.js';

// A delivery row stored with the recipient's postcode in its place takes the place without it, or none.
const reread = (location: string) => hualeiScanText(location, 200);

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'gzyl', storedSources: ['gzyl'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesRereadLocation(incoming, stored, reread)
    || matchesDroppedLocation(incoming, stored, (location) => !reread(location)),
};
