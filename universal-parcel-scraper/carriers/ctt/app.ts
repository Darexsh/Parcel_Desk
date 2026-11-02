import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scan times were read as the UTC their Z says until October 2026, and now show
// the clock of the place the scan happened: Lisbon's, the Azores' or the
// destination's. Lisbon's winter scans keep their instants under +00:00. A
// CTT Express agency's scan stored on Lisbon's clock shows the same wall clock
// on Madrid's.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'ctt', storedSources: ['ctt'], requireProviderCode: true, relabelledFrom: 'UTC', matchWallClock: true,
};
