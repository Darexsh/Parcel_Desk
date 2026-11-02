import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Verified and postcode-free replies reword the same scans at the same instants.
// A universal provider can also have stored those scans while DPD was unavailable.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd', storedSources: ['dpd', 'unknown'], requireProviderCode: false,
};
