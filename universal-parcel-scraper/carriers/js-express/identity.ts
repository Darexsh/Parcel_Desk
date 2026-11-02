import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { translatedScanPolicy } from '../../core/status/english.js';
import { jsExpressEnglish } from './status.js';

// Rows stored in the carrier's Chinese before the adapter showed their English
// are taken over by the English row at the same instant and place.
const translated = translatedScanPolicy('js-express', jsExpressEnglish);

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  ...translated,
  // A row stored with a label that names no place, without a letter as the parser reads it, is
  // taken over by the row without it.
  matches: (incoming, stored) => translated.matches!(incoming, stored)
    || matchesDroppedLocation(incoming, stored, (location) => !/\p{L}/u.test(location)),
};
