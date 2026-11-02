import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scans stored while the endpoint was asked for French take its English wording
// in place: at one instant, the event code names the same scan.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'postlogistics', storedSources: ['postlogistics'], requireProviderCode: true,
};
