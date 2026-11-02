import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

// Scans stored before their depot's town became their location keep their
// instant, wording and stage, and gain the town in place.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'ciblex', storedSources: ['ciblex'], requireProviderCode: false,
  matchEachScan: true,
  matches: matchesLocationEnrichment,
};
