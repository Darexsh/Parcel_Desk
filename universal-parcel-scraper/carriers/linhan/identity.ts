import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One row, by its wording and town. LinHan's rows have no code. */
function sameRow(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

// Earlier releases left the rows abroad on wall clocks, dated on the town's
// zone for Node lookups. Read on Beijing time, a row shows the same wall clock
// under another offset and takes over the row stored from it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'linhan', storedSources: ['linhan'], requireProviderCode: false,
  matchEachScan: true, matches: sameRow, matchWallClock: true,
};
