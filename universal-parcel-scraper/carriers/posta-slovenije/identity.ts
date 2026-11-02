import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// A foreign post's relayed events kept the Ljubljana reading Pošta Slovenije
// gives them until October 2026 and now show that post's clock, unless its
// country keeps several.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'posta-slovenije', storedSources: ['posta-slovenije'], requireProviderCode: true, relabelledFrom: 'Europe/Ljubljana',
};
