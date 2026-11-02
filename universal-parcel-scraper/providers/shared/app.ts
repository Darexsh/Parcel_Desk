import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment, matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { chinaPostEnglish, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { place, trailingPlace } from './result.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A China Post label stored in Chinese before 17TRACK's copy showed its
 * English: the English of the stored label, at the location stored or as
 * the provider now reads it, or at the name the label gave in 【】 where that
 * reads as none, with provider codes that agree.
 */
function matchesChinaPostEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const english = chinaPostEnglish(stored.description);
  const location = normalized(incoming.location);
  const named = place(stored.location) ? '' : place(chinaPostLabelPlace(stored.description) ?? '');
  return english !== undefined && normalized(english) === normalized(incoming.description)
    && (location === normalized(stored.location) || location === normalized(place(stored.location)) || (named !== '' && location === normalized(named)))
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A scan stored without a location, its place in brackets after the wording,
 * before 17TRACK's copy took that place for the location: the same wording
 * at that place, with provider codes that agree.
 */
function matchesTrailingPlace(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const trailing = stored.location.trim() ? undefined : trailingPlace(stored.description);
  return trailing !== undefined && normalized(trailing.wording) === normalized(incoming.description)
    && normalized(trailing.place) === normalized(incoming.location)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// A copy may add a place, or drop a label it was once stored with that names
// no place (Posti's "abroad", a feed's system user) or the words before a
// depot's town, show a China Post label in English, or take the place from
// after its wording.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'unknown', storedSources: ['unknown'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored)
    || matchesRereadLocation(incoming, stored, place) || matchesChinaPostEnglish(incoming, stored)
    || matchesTrailingPlace(incoming, stored),
};
