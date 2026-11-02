import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

/** Whether a relayed scan's place is a partner's placeholder ("Not Available"), which names no place. */
export function isYanwenPlaceholder(location: string): boolean {
  return /^(?:not available|AA)$/i.test(location.replace(/\s+/g, ' ').trim());
}

// A relayed scan stored without a place can take it from the UTC copy the
// adapter now drops, and one stored with a placeholder as its place loses it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yanwen', storedSources: ['yanwen'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored) || matchesDroppedLocation(incoming, stored, isYanwenPlaceholder),
};
