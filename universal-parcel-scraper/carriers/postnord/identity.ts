import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// One scan read twice keeps its code, wording and place.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return Boolean(incoming.providerCode) && incoming.providerCode === stored.providerCode
    && Boolean(normalized(incoming.description)) && normalized(incoming.description) === normalized(stored.description)
    && normalized(incoming.location) === normalized(stored.location);
}

// Relayed scans without a place, and a terminal's scans to the minute, were
// read as UTC until October 2026 and now show the wall clock of their country.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'postnord', storedSources: ['postnord'], requireProviderCode: true,
  matchEachScan: true, matches, relabelledFrom: 'UTC',
};
