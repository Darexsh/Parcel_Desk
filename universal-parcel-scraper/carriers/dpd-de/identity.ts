import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const place = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');

// The guest API's hand-over is the first depot's scan, which the app calls "In transit.":
// DPD's map leaves the hand-over unstaged, so its wording reads as accepted.
const handOver = (guest: SameInstantScan, app: SameInstantScan) => guest.providerCode === 'PARCEL_HANDED'
  && app.description.replace(/\s+/g, ' ').trim().toLowerCase() === 'in transit.';

// The app service and the guest API answer apart and date one scan to the
// minute and to the second, in their own wording. Only the guest API's scans
// carry DPD's code, and its unverified reply names no place. A scan from one
// service matches a stored scan from the other at the same stage, or the
// hand-over in either's words, and at the same place, or where one of them
// names none.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const [location, saved] = [place(incoming.location), place(stored.location)];
  return incoming.stage !== ''
    && (incoming.stage === stored.stage || handOver(incoming, stored) || handOver(stored, incoming))
    && !incoming.providerCode !== !stored.providerCode
    && (location === saved || !location || !saved);
}

// A unit abroad's scans, which a release dates on that unit's clock rather than Germany's, keep their rows.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd-de', storedSources: ['dpd-de'], requireProviderCode: false, matchEachScan: true, matches, matchWithinMinute: true,
  matchWallClock: true,
};
