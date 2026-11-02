import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/** NZ Post's depot placeholder for a scan with no place. */
export function isNzPostPlaceholderLocation(location: string): boolean {
  return normalized(location) === '(location not available)';
}

// International scans stored with the shared classifier's stage, or none, take
// the stage of their EDIFACT code in place, and a stored placeholder depot is
// dropped. The code and wording must agree; conflicting places stay separate.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(wording) && Boolean(incoming.providerCode) && incoming.providerCode === stored.providerCode
    && wording === normalized(stored.description)
    && (location === savedLocation || (!location && isNzPostPlaceholderLocation(savedLocation)));
}

// Scans abroad were read on Auckland's clock until October 2026 and now show
// the offset of the country they happened in, unless nothing places them.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'nz-post', storedSources: ['nz-post'], requireProviderCode: true,
  matchEachScan: true, matches, relabelledFrom: 'Pacific/Auckland',
};
