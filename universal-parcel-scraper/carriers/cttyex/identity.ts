import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { linhanScan } from '../linhan/scan.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One row, by its wording and place. CTTYEX's rows have no code. */
function sameRow(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

/** One row, or a row abroad stored with its town, state and ZIP code in the wording, read as the adapter now reads it. */
function placedRow(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return sameRow(incoming, stored) || (Boolean(incoming.location.trim()) && !stored.location.trim()
    && sameRow(incoming, { ...stored, ...linhanScan(stored.description) }));
}

// Earlier releases left the rows abroad on wall clocks, which apps dated on
// Beijing time, with their place in the wording. Read on Beijing time with the
// place moved into the location, a row takes over the one stored for it, and
// a row dated on another zone shows the same wall clock under another offset.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'cttyex', storedSources: ['cttyex'], requireProviderCode: false,
  matchEachScan: true, matches: placedRow, matchWallClock: true,
};
