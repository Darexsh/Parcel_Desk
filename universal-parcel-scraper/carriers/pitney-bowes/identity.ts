import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { interpostClearance } from './status.js';

/**
 * Interpost's import declaration, which its own tracker captions "Customs
 * Import submitted". Its place names only the country it is lodged in.
 */
const DECLARATION = /^customs clearance$/i;
const COUNTRY_ONLY = /^[A-Z]{2}$/;

/** The country an import declaration names as its place, which is paperwork, not where the parcel is. */
export function declarationCountry(description: string, location: string): string | null {
  return DECLARATION.test(description.trim()) && COUNTRY_ONLY.test(location.trim()) ? location.trim() : null;
}

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/** One scan read again: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return normalized(incoming.description) !== '' && normalized(incoming.description) === normalized(stored.description)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/** A clearance stored under its status code, now shown in words with the code as its provider code. */
function wordedClearance(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const clearance = interpostClearance(stored.description);
  return clearance !== null && normalized(incoming.description) === normalized(clearance.wording)
    && (!incoming.providerCode || normalized(incoming.providerCode) === normalized(clearance.code))
    && normalized(incoming.location) === normalized(stored.location);
}

// A scan keeps its row, as do an import declaration stored at the country it
// names, once shown without it, and a clearance stored under its code, once
// shown in words.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'pitney-bowes', storedSources: ['pitney-bowes'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => sameScan(incoming, stored)
    || matchesDroppedLocation(incoming, stored, (location) => declarationCountry(stored.description, location) !== null)
    || wordedClearance(incoming, stored),
};
