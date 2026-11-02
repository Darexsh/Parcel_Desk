import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { translatedScanPolicy } from '../../core/status/english.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { chinaPostEnglish, chinaPostPlace } from './status.js';

// Rows stored in China Post's Chinese label before the adapter showed its English
// are taken over by the English row at the same instant and place.
const translated = translatedScanPolicy('china-post', chinaPostEnglish);

/**
 * A row stored with its country in China Post's Chinese name (日本), which now
 * shows in English, in the same or translated wording and with codes that agree.
 */
function countryInEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const place = chinaPostPlace(stored.location);
  if (place === stored.location.trim() || place !== incoming.location.trim()) return false;
  const moved = { ...stored, location: incoming.location };
  const wording = normalizeStatusWording(incoming.description);
  return translated.matches!(incoming, moved) || (wording !== '' && wording === normalizeStatusWording(stored.description)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  ...translated,
  matches: (incoming, stored) => translated.matches!(incoming, stored) || countryInEnglish(incoming, stored),
};
