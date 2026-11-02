import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => sunYouWording(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A scan's wording without the last-mile number SunYou appends to its departure
 * ("Departed Sunyou Facility, Carrier Tracking Number: …"): the result's hand-off
 * carries it. Rows stored with it take the shorter wording in place.
 */
export function sunYouWording(content: string): string {
  return content.replace(/,?\s*Carrier Tracking Number:\s*[A-Z0-9-]*\s*$/i, '').trim() || content;
}

// Scans stored before SunYou's event codes were kept have none, and their
// stage came from their wording or from nothing. They take the code and its
// stage in place when the wording and place are unchanged; a different code
// is a different scan.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  return wording !== '' && Boolean(incoming.providerCode)
    && (!stored.providerCode || stored.providerCode === incoming.providerCode)
    && wording === normalized(stored.description)
    && normalized(incoming.location) === normalized(stored.location);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'sunyou', storedSources: ['sunyou'], requireProviderCode: false,
  matchEachScan: true, matches,
};
