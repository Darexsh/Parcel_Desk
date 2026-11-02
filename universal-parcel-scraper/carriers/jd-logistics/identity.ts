import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { scanWording } from './wording.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// Scans stored before JD Logistics' operation codes were kept have none, and
// their stage came from their wording or from nothing. They take the code and
// its stage in place when the place is unchanged and the wording is too, once
// the courier's contact or the partner's number a stored row may still hold is
// dropped from it. A different code is a different scan.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  return wording !== '' && Boolean(incoming.providerCode)
    && (!stored.providerCode || stored.providerCode === incoming.providerCode)
    && wording === normalized(scanWording(stored.description))
    && normalized(incoming.location) === normalized(stored.location);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'jd-logistics', storedSources: ['jd-logistics'], requireProviderCode: false,
  matchEachScan: true, matches,
};
