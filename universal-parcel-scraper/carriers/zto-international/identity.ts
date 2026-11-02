import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan, by its wording and place, and its code when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// Earlier releases left the scans on wall clocks, dated on their place's or
// destination's zone for Node lookups. Read on Shanghai's clock, a scan shows
// the same wall clock under another offset and takes over the row stored from it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'zto-international', storedSources: ['zto-international'], requireProviderCode: false,
  matchEachScan: true, matches: sameScan, matchWallClock: true,
};
