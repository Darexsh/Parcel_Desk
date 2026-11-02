import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Colissimo scans abroad kept the Paris offset La Poste labels a partner's
// wall clock with until October 2026 and now show their country's, unless
// the country keeps several clocks.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'la-poste', storedSources: ['la-poste'], requireProviderCode: true, relabelledFrom: 'Europe/Paris',
};
