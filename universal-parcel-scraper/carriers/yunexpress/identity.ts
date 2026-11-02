import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { chinaPostAirline } from '../china-post/status.js';
import { chinaPostOffice, chinaPostRelayEnglish, withoutRepeatedParts } from './status.js';

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const wording = (scan: SameInstantScan) => normalized(scan.description);
/** A stored row's place: an airline stored as one (邮政航空) is none, and a part stored twice in a row is read once. */
const place = (scan: SameInstantScan) => chinaPostAirline(scan.location) ? '' : withoutRepeatedParts(scan.location.trim());

/** One row, by its wording and place. Yuntrack's rows have no code. */
function sameRow(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === place(stored);
}

/** A China Post arrival or departure stored with its office in the wording, which is now its place. */
function sameOffice(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const scan = chinaPostOffice(stored.description);
  return scan !== undefined && normalized(scan.wording) === wording(incoming) && scan.office === incoming.location.trim();
}

/** A China Post scan stored in its Chinese, which now shows in English, at its office or the feed's place. */
function sameInEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const english = chinaPostRelayEnglish(stored.description, stored.location);
  const office = chinaPostOffice(stored.description)?.office ?? place(stored);
  return english !== undefined && normalized(english) === wording(incoming) && office === incoming.location.trim();
}

// Earlier releases dated the rows without a place on China's leg on the
// destination's zone for Node lookups. Read on China's clock, a row shows the
// same wall clock under another offset and takes over the row stored from it,
// as a China Post scan in English does the one stored in Chinese.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yunexpress', storedSources: ['yunexpress'], requireProviderCode: false,
  matchEachScan: true, matches: (incoming, stored) => sameRow(incoming, stored) || sameOffice(incoming, stored) || sameInEnglish(incoming, stored),
  matchWallClock: true,
};
