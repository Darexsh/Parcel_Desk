import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
// The wording the parser keeps for a release, without the representative's name.
const RELEASED = 'released to authorized representative';

// App scans stored before they had a town and province gain them in place, and a
// release stored with its representative's name takes the wording without it.
// The stage may differ: code 0 scans took the shared classifier's stage before
// LBC's wording gave them theirs.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const saved = normalized(stored.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(wording) && incoming.providerCode === stored.providerCode
    && (wording === saved || (wording === RELEASED && saved.startsWith(`${RELEASED} `)))
    && (!savedLocation || location === savedLocation);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'lbc-express', storedSources: ['lbc-express'], requireProviderCode: true,
  matchEachScan: true, matches,
};
