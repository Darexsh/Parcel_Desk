import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scans relayed from the post abroad were read as UTC until October 2026 and now
// show that office's offset, unless the reply cannot place them.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'australia-post', storedSources: ['australia-post'], requireProviderCode: true, relabelledFrom: 'UTC',
};
