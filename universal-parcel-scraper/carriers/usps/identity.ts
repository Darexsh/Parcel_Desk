import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

/**
 * A scan's wording without what USPS rewrites as the parcel moves on: the
 * delivery window of an out-for-delivery scan, and the newest place-less
 * transit step's "Arriving On Time" or "Arriving Late", which reads "In Transit
 * to Next Facility" once a later step comes.
 */
function lastingWording(description: string): string {
  const wording = description.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^out for delivery\b/.test(wording)) return 'out for delivery';
  if (/^in transit(?:, arriving (?:on time|late)| to next facility)$/.test(wording)) return 'in transit';
  return wording;
}

// A scan takes over the row stored in its earlier wording at its instant and place. A place-less
// scan is dated on a deduced zone that a later scan can change: it takes over the row showing its
// wall clock under another offset.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'usps', storedSources: ['usps'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => lastingWording(incoming.description) !== ''
    && lastingWording(incoming.description) === lastingWording(stored.description)
    && incoming.location.trim() === stored.location.trim(),
  matchWallClock: true,
};
