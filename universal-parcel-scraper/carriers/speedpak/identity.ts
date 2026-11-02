import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { translatedScanPolicy } from '../../core/status/english.js';
import { speedpakEnglish } from './status.js';
import { speedpakPlace, withoutRoutingPrefix } from './wording.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// A hand-off line stored with a USPS routing barcode, which opens with the
// recipient's ZIP code, takes the wording without it in place. Only that trim
// is matched: the instant, the place and the rest of the wording are unchanged.
function trimmedRouting(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const trimmed = withoutRoutingPrefix(stored.description);
  return wording !== '' && trimmed !== stored.description && wording === normalized(trimmed)
    && normalized(incoming.location) === normalized(stored.location);
}

// A row stored with a country's code and the destination country as its place takes the code alone.
const reread = (location: string) => {
  const fields = /^([^,]+), ([^,]+)$/.exec(location);
  return fields ? speedpakPlace(fields[1]!, fields[2]!) : location;
};

// A row stored in SpeedPAK's Chinese takes the English the adapter now shows.
const translated = translatedScanPolicy('speedpak', speedpakEnglish);

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'speedpak', storedSources: ['speedpak'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => trimmedRouting(incoming, stored) || matchesRereadLocation(incoming, stored, reread)
    || translated.matches!(incoming, stored),
};
