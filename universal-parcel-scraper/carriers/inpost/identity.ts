import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scans stored while the hub answered in Polish take its English wording in
// place: at one instant, the same stage and place name the same scan.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'inpost', storedSources: ['inpost'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => incoming.stage === stored.stage && incoming.location.trim() === stored.location.trim(),
};
