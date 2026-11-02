import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { decodeEntities } from './text.js';

/** Wording or a place as UPS shows it: scans stored before October 2026 kept its HTML escapes. */
function normalized(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

/**
 * Two readings of one activity. Scans stored before UPS's activity codes were
 * kept have none, and their stage came from their wording instead of the code.
 */
function sameActivity(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  if (incoming.providerCode && stored.providerCode) return incoming.providerCode === stored.providerCode;
  return incoming.providerCode !== '' || incoming.stage === stored.stage;
}

/** One town, or a place only one of the two names: the page and the official API write the rest of it differently. */
function sameTown(incoming: string, stored: string): boolean {
  const town = (place: string) => normalized(place).split(',')[0]!.trim();
  return !incoming.trim() || !stored.trim() || town(incoming) === town(stored);
}

// UPS can add a location later. Its wording distinguishes scans sharing a clock,
// unless both carry an activity code: the official API words a scan without the
// page's second sentence and writes its town in capitals. A scan UPS stated on the
// offset its place keeps in the other season, which a release dates on the place's
// clock, keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'ups', storedSources: ['ups'], requireProviderCode: false, matchWallClock: true,
  matches(incoming, stored) {
    if (incoming.stage === '' || incoming.stage === 'unknown' || !sameActivity(incoming, stored)) return false;
    if (incoming.providerCode && stored.providerCode) return sameTown(incoming.location, stored.location);
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    const savedLocation = normalized(stored.location);
    return wording !== '' && wording === normalized(stored.description)
      && (!location || !savedLocation || location === savedLocation);
  },
};
