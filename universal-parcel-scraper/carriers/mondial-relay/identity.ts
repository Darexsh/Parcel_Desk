import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

// Scans stored before their logistics site became their location keep their
// instant, wording and stage, and gain the site in place.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'mondial-relay', storedSources: ['mondial-relay'], requireProviderCode: false,
  matchEachScan: true,
  matches: matchesLocationEnrichment,
};
