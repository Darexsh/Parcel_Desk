import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { withoutCountryCode } from './place.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan, by its wording and place. Shouwu's scans have no code. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

// Earlier releases read each epoch as the scan's instant. It is the scan's wall
// clock read on Beijing time, so a scan abroad now shows that wall clock under
// its place's offset and takes over the row stored from it. A row stored with
// the country's code before its place is taken over by the place without it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'shouwu', storedSources: ['shouwu'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => sameScan(incoming, stored) || matchesRereadLocation(incoming, stored, withoutCountryCode),
  relabelledFrom: 'Asia/Shanghai',
};
