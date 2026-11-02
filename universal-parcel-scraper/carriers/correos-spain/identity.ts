import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// The localizador words a scan in the language a lookup asks for, so a scan
// stored in one language takes another's wording in place: at one instant,
// the event code names the same scan. An origin post's scans on an item from
// abroad, and a Canary Islands delivery unit's, kept the Madrid reading until
// October 2026 and now show their own clock, unless the origin's country keeps
// several.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'correos-spain', storedSources: ['correos-spain'], requireProviderCode: true, relabelledFrom: 'Europe/Madrid',
};
